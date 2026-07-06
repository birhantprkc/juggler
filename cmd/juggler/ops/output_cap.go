//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import "fmt"

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
