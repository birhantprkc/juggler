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
