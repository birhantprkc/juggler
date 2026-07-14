//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bufio"
	"fmt"
	"io"
)

// Output truncation limits. A shell command can emit hundreds of megabytes
// (`yes`, a broken loop, `cat` of a huge file). Forwarding all of it floods the
// engine WebView with tens of thousands of WebSocket messages, wedges it for
// minutes, and starves every other command's delivery on the shared outbound
// channel — the "server lock-up" failure mode. We therefore keep only the first
// outputHeadLimit bytes plus the last outputTailLimit bytes; the middle is
// dropped with a marker. Head+tail mirrors the JS smartTruncate policy so the
// important parts (initial context, final errors/summary) both survive.
const (
	outputHeadLimit = 512 * 1024
	outputTailLimit = 256 * 1024
)

// truncationMarker is the inline notice stitched between the retained head and
// tail when output was dropped.
func truncationMarker(omitted int64) string {
	return fmt.Sprintf("\n\n… [output truncated: %d bytes omitted] …\n\n", omitted)
}

// tailRing keeps the last `size` bytes written to it, discarding older bytes in
// O(1) amortised per write via a fixed circular buffer. Used to retain the tail
// of an over-long stream without buffering the whole thing.
type tailRing struct {
	buf  []byte
	size int
	pos  int  // next write index
	full bool // whether buf has wrapped at least once
}

func newTailRing(size int) *tailRing {
	if size < 0 {
		size = 0
	}
	return &tailRing{buf: make([]byte, size), size: size}
}

// write appends p, keeping only the most recent `size` bytes.
func (t *tailRing) write(p []byte) {
	if t.size == 0 {
		return
	}
	// If p alone overfills the ring, only its own tail matters.
	if len(p) >= t.size {
		copy(t.buf, p[len(p)-t.size:])
		t.pos = 0
		t.full = true
		return
	}
	n := copy(t.buf[t.pos:], p)
	if n < len(p) {
		// Wrapped around the end of the buffer.
		copy(t.buf, p[n:])
		t.pos = len(p) - n
		t.full = true
	} else {
		t.pos += n
		if t.pos == t.size {
			t.pos = 0
			t.full = true
		}
	}
}

// bytes returns the retained tail in write order.
func (t *tailRing) bytes() []byte {
	if !t.full {
		return append([]byte(nil), t.buf[:t.pos]...)
	}
	out := make([]byte, t.size)
	n := copy(out, t.buf[t.pos:])
	copy(out[n:], t.buf[:t.pos])
	return out
}

// cappedBuffer is an io.Writer that accumulates output but retains only the
// first headLimit bytes and the last tailLimit bytes, so a runaway command
// can't exhaust memory. It is a drop-in replacement for *bytes.Buffer on the
// non-streaming execution paths: Write never errors and String() stitches the
// retained head, a truncation marker, and the retained tail.
type cappedBuffer struct {
	head      []byte
	headLimit int
	tail      *tailRing
	total     int64
	truncated bool
}

func newCappedBuffer(headLimit, tailLimit int) *cappedBuffer {
	return &cappedBuffer{headLimit: headLimit, tail: newTailRing(tailLimit)}
}

// Write implements io.Writer. It always consumes all of p.
func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.total += int64(len(p))
	if len(b.head) < b.headLimit {
		room := b.headLimit - len(b.head)
		if len(p) <= room {
			b.head = append(b.head, p...)
			return len(p), nil
		}
		b.head = append(b.head, p[:room]...)
		b.truncated = true
		b.tail.write(p[room:])
		return len(p), nil
	}
	b.truncated = true
	b.tail.write(p)
	return len(p), nil
}

// String returns the retained output, with a marker in place of the dropped
// middle when truncation occurred.
func (b *cappedBuffer) String() string {
	if !b.truncated {
		return string(b.head)
	}
	tail := b.tail.bytes()
	omitted := b.total - int64(len(b.head)) - int64(len(tail))
	if omitted < 0 {
		omitted = 0
	}
	return string(b.head) + truncationMarker(omitted) + string(tail)
}

// cappedForwarder streams a byte source to a sink live, but only up to
// headLimit bytes; past that it stops forwarding, retains just the last
// tailLimit bytes in a ring, and drops the middle — the same head+tail policy
// as cappedBuffer, but pushing to a sink instead of accumulating for String().
// It also stitches UTF-8 runes split across reads (see utf8SafeChunk) so the
// sink never receives an invalid half.
//
// Concurrency: drain() mutates the counters and ring, so it must run on a
// single goroutine; suffix() reads them and may only be called after that
// goroutine has returned (a happens-before edge — e.g. a WaitGroup join or a
// done channel receive).
type cappedForwarder struct {
	headLimit int64
	sink      func(string)
	tail      *tailRing
	headBytes int64
	totalRead int64
	truncated bool
}

func newCappedForwarder(headLimit, tailLimit int, sink func(string)) *cappedForwarder {
	return &cappedForwarder{
		headLimit: int64(headLimit),
		sink:      sink,
		tail:      newTailRing(tailLimit),
	}
}

// forward pushes emit through the head/tail cap: live to the sink while under
// headLimit, into the tail ring once over it.
func (f *cappedForwarder) forward(emit []byte) {
	if len(emit) == 0 {
		return
	}
	f.totalRead += int64(len(emit))
	if f.headBytes < f.headLimit {
		room := int(f.headLimit - f.headBytes)
		if len(emit) <= room {
			f.sink(string(emit))
			f.headBytes += int64(len(emit))
			return
		}
		// Straddles the head limit: forward the head portion, retain the rest.
		f.sink(string(emit[:room]))
		f.headBytes += int64(room)
		f.truncated = true
		f.tail.write(emit[room:])
		return
	}
	f.truncated = true
	f.tail.write(emit)
}

// drain reads r to EOF in 4 KiB reads, forwarding UTF-8-safe chunks to the
// sink. If onFirstByte is non-nil it is invoked on each read that yields bytes
// (callers pass an idempotent signal to learn when output first appears).
func (f *cappedForwarder) drain(r io.Reader, onFirstByte func()) {
	reader := bufio.NewReader(r)
	buf := make([]byte, 4096)
	// carry holds the trailing bytes of a multi-byte UTF-8 rune split across two
	// reads; utf8SafeChunk prepends it to the next read so we never forward an
	// invalid half (which would render as U+FFFD).
	var carry []byte
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			if onFirstByte != nil {
				onFirstByte()
			}
			var emit []byte
			emit, carry = utf8SafeChunk(carry, buf[:n], false)
			f.forward(emit)
		}
		if err != nil {
			break
		}
	}
	f.forward(carry) // flush any trailing partial rune left when the stream ended
}

// suffix returns the dropped-middle marker plus the retained tail, or "" when
// nothing was dropped. Call only after drain() has returned (see the
// concurrency note on cappedForwarder).
func (f *cappedForwarder) suffix() string {
	if !f.truncated {
		return ""
	}
	tailBytes := f.tail.bytes()
	omitted := f.totalRead - f.headBytes - int64(len(tailBytes))
	if omitted < 0 {
		omitted = 0
	}
	return truncationMarker(omitted) + string(tailBytes)
}

// utf8SafeChunk splits a freshly-read chunk (cur), prepended with any bytes
// carried from the previous read (prev), into the portion that ends on a UTF-8
// rune boundary (emit) and the trailing bytes of an incomplete multi-byte rune
// to carry into the next read (carry).
//
// Streaming readers read into fixed 4096-byte buffers, so a multi-byte rune
// (emoji, CJK, accented text) can straddle a read boundary. Forwarding each
// half independently is lossy: each is invalid UTF-8 on its own, and Go's
// json.Marshal replaces every invalid byte with U+FFFD before the frontend can
// rejoin them — visible corruption even for perfectly valid UTF-8 output.
// Holding the trailing partial rune back until the next read fixes this.
//
// When atEOF is true there is no next read (the stream has ended), so a
// genuinely-truncated trailing sequence is returned as emit rather than held.
// The returned carry is always freshly allocated, so callers may reuse cur's
// backing buffer immediately.
func utf8SafeChunk(prev, cur []byte, atEOF bool) (emit, carry []byte) {
	combined := cur
	if len(prev) > 0 {
		combined = append(append([]byte(nil), prev...), cur...)
	}
	if atEOF {
		return combined, nil
	}
	validLen := findLastCompleteUTF8(combined)
	if validLen >= len(combined) {
		return combined, nil
	}
	return combined[:validLen], append([]byte(nil), combined[validLen:]...)
}
