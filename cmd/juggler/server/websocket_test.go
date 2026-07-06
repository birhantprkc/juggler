//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"testing"
)

// TestRetryableWriteError pins which write errors the writePump retries vs
// treats as connection death. ENOBUFS is transient kernel backpressure (the
// loopback socket's buffer filled under burst load — observed under the
// 9-lane test pool); killing the connection for it permanently starves one
// client of all worker broadcasts while the rest of the process hums along,
// which presents as a single viewer's doc frozen mid-turn. Genuine
// connection errors must still terminate the pump promptly.
func TestRetryableWriteError(t *testing.T) {
	enobufs := &net.OpError{Op: "writev", Net: "tcp",
		Err: os.NewSyscallError("writev", syscall.ENOBUFS)}
	if !retryableWriteError(enobufs) {
		t.Error("ENOBUFS (kernel buffer exhaustion) must be retried, not treated as a dead connection")
	}

	for _, err := range []error{
		&net.OpError{Op: "writev", Net: "tcp", Err: os.NewSyscallError("writev", syscall.EPIPE)},
		&net.OpError{Op: "writev", Net: "tcp", Err: os.NewSyscallError("writev", syscall.ECONNRESET)},
		errors.New("websocket: close sent"),
		fmt.Errorf("wrapped: %w", errors.New("use of closed network connection")),
	} {
		if retryableWriteError(err) {
			t.Errorf("%v must terminate the pump, not be retried", err)
		}
	}
}
