//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

// tailRing keeps the last `size` bytes written to it, discarding older bytes via
// a fixed circular buffer. Used to retain a server's recent stderr for the
// diagnostics UI without buffering the whole stream. It is owned by the manager
// goroutine, so it needs no locking. (Deliberately a private copy of the ops
// package's tailRing, which is unexported there.)
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
	if len(p) >= t.size {
		copy(t.buf, p[len(p)-t.size:])
		t.pos = 0
		t.full = true
		return
	}
	n := copy(t.buf[t.pos:], p)
	if n < len(p) {
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
