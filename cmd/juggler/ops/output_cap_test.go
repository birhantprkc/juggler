//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"runtime"
	"strings"
	"testing"
)

// TestExecuteStreaming_BoundsLargeOutput guards the fix for the server-lock-up /
// performance bug: a command that pumps out far more than the head+tail budget
// must not stream its full output. We assert the streamed total is bounded, the
// head and tail both survive, and a truncation marker is present.
func TestExecuteStreaming_BoundsLargeOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("seq/sh streaming command is POSIX-only")
	}

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	out := make(chan ShellStreamChunk, 1024)

	var b strings.Builder
	doneCollecting := make(chan struct{})
	go func() {
		for c := range out {
			b.WriteString(c.Data)
		}
		close(doneCollecting)
	}()

	// `seq 1 2000000` emits megabytes across 2M lines — well past the 768 KB
	// head+tail budget — then a sentinel marks the very end of the stream so we
	// can assert the tail survived. (We avoid asserting on seq's own values:
	// BSD seq switches to scientific notation like "2e+06" for large numbers.)
	const tailSentinel = "END_SENTINEL_XYZ"
	shellOps.ExecuteStreaming(context.Background(), "shell-test", "seq 1 2000000; echo "+tailSentinel, "", 60000, out)
	<-doneCollecting

	s := b.String()

	// 1. Bounded: head + tail + a small margin for the marker.
	limit := outputHeadLimit + outputTailLimit + 4096
	if len(s) > limit {
		t.Fatalf("streamed output not bounded: got %d bytes, want <= %d", len(s), limit)
	}

	// 2. Head survived (output starts at the beginning of the stream).
	if !strings.HasPrefix(s, "1\n2\n3\n") {
		t.Fatalf("head missing: output does not start with the first lines, got %.40q", s)
	}

	// 3. Tail survived (the end of the stream reached the client via the final chunk).
	if !strings.Contains(s, tailSentinel) {
		t.Fatalf("tail missing: sentinel %q not present in streamed output", tailSentinel)
	}

	// 4. Truncation was announced.
	if !strings.Contains(s, "truncated") {
		t.Fatalf("truncation marker missing from streamed output")
	}
}

// TestExecuteStreaming_SmallOutputNotTruncated verifies the common case is
// untouched: output under budget streams verbatim with no marker.
func TestExecuteStreaming_SmallOutputNotTruncated(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	out := make(chan ShellStreamChunk, 64)

	var b strings.Builder
	doneCollecting := make(chan struct{})
	go func() {
		for c := range out {
			b.WriteString(c.Data)
		}
		close(doneCollecting)
	}()

	shellOps.ExecuteStreaming(context.Background(), "shell-test", "printf 'hello world\\n'", "", 30000, out)
	<-doneCollecting

	s := b.String()
	if strings.TrimSpace(s) != "hello world" {
		t.Fatalf("small output altered: got %q", s)
	}
	if strings.Contains(s, "truncated") {
		t.Fatalf("small output should not be truncated, got %q", s)
	}
}

// TestCappedBuffer_HeadAndTail unit-tests the buffered-path cap directly.
func TestCappedBuffer_HeadAndTail(t *testing.T) {
	b := newCappedBuffer(8, 8)
	// Write 30 bytes: "AAAAAAAA...BBBB...". Head should keep first 8, tail last 8.
	for i := 0; i < 30; i++ {
		_, _ = b.Write([]byte{byte('a' + i%26)})
	}
	got := b.String()
	if !strings.HasPrefix(got, "abcdefgh") {
		t.Fatalf("head wrong: %q", got)
	}
	if !strings.Contains(got, "truncated") {
		t.Fatalf("marker missing: %q", got)
	}
	// Last 8 of 30 chars cycling a..z: indices 22..29 -> w,x,y,z,a,b,c,d
	if !strings.HasSuffix(got, "wxyzabcd") {
		t.Fatalf("tail wrong: %q", got)
	}
}

// TestUTF8SafeChunk_SplitRune verifies a multi-byte rune split across two reads
// is emitted whole: the leading bytes are held back as carry, then completed by
// the next read — never forwarded as two invalid halves.
func TestUTF8SafeChunk_SplitRune(t *testing.T) {
	full := []byte("ab世cd") // 世 = E4 B8 96

	// First read ends one byte into 世 (…a b E4). The E4 must be carried.
	emit1, carry1 := utf8SafeChunk(nil, full[:3], false)
	if string(emit1) != "ab" {
		t.Fatalf("emit1 = %q, want \"ab\"", emit1)
	}
	if len(carry1) != 1 || carry1[0] != 0xE4 {
		t.Fatalf("carry1 = % x, want e4", carry1)
	}

	// Second read supplies the rest (B8 96 c d); the carried E4 completes 世.
	emit2, carry2 := utf8SafeChunk(carry1, full[3:], false)
	if string(emit2) != "世cd" {
		t.Fatalf("emit2 = %q, want \"世cd\"", emit2)
	}
	if len(carry2) != 0 {
		t.Fatalf("carry2 = % x, want empty", carry2)
	}

	if got := string(emit1) + string(emit2); got != string(full) {
		t.Fatalf("reassembled = %q, want %q", got, string(full))
	}
}

// TestUTF8SafeChunk_FlushAtEOF verifies a genuinely-truncated trailing partial
// rune is emitted (not swallowed) once the stream has ended.
func TestUTF8SafeChunk_FlushAtEOF(t *testing.T) {
	in := []byte{'x', 0xE4} // trailing lone start byte of a 3-byte rune
	emit, carry := utf8SafeChunk(nil, in, true)
	if len(carry) != 0 {
		t.Fatalf("carry = % x, want empty at EOF", carry)
	}
	if string(emit) != string(in) {
		t.Fatalf("emit = % x, want % x", emit, in)
	}
}

// TestExecuteStreaming_NoRuneSplitCorruption is the end-to-end regression guard:
// a stream of multi-byte runes long enough to cross many 4096-byte read
// boundaries must arrive intact, with no U+FFFD replacement characters.
func TestExecuteStreaming_NoRuneSplitCorruption(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX-only shell command")
	}

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	out := make(chan ShellStreamChunk, 4096)

	var b strings.Builder
	doneCollecting := make(chan struct{})
	go func() {
		for c := range out {
			b.WriteString(c.Data)
		}
		close(doneCollecting)
	}()

	// 20000 copies of the 3-byte rune 世 = 60000 bytes: well under the head
	// budget (so nothing is truncated) but far past many 4096-byte read
	// boundaries, and 60000 % 4096 != 0 so runes straddle those boundaries.
	const n = 20000
	shellOps.ExecuteStreaming(context.Background(), "shell-test",
		"printf '世%.0s' $(seq 1 20000)", "", 30000, out)
	<-doneCollecting

	got := b.String()
	if strings.ContainsRune(got, '\uFFFD') {
		t.Fatalf("output contains U+FFFD — a rune was split across a read boundary")
	}
	if want := strings.Repeat("世", n); got != want {
		t.Fatalf("output mismatch: got %d bytes, want %d", len(got), len(want))
	}
}
