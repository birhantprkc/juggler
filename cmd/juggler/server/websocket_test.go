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
	"time"
)

// gorillaTimeoutErr mimics the error gorilla/websocket returns when a write
// deadline expires: its own net.Error implementation, carrying Timeout() but
// NOT wrapping the original os.ErrDeadlineExceeded. Classifying it is the
// whole reason writeDeadlineExceeded matches on the interface — a test built
// on os.ErrDeadlineExceeded would pass against a sentinel check that fails in
// production.
type gorillaTimeoutErr struct{}

func (gorillaTimeoutErr) Error() string   { return "write tcp 127.0.0.1:1->127.0.0.1:2: i/o timeout" }
func (gorillaTimeoutErr) Timeout() bool   { return true }
func (gorillaTimeoutErr) Temporary() bool { return true }

// TestWriteDeadlineExceededClassification pins that an expired write deadline
// is recognised through the net.Error interface and is fatal to the
// connection, not fed into the ENOBUFS retry ladder. A peer that stopped
// reading does not start again because we tried twenty more times, and gorilla
// latches the first write error on a connection anyway, so retrying a timeout
// only delays the close that lets the client reconnect.
func TestWriteDeadlineExceededClassification(t *testing.T) {
	timeout := error(gorillaTimeoutErr{})

	if errors.Is(timeout, os.ErrDeadlineExceeded) {
		t.Fatal("test fixture no longer mimics gorilla: it must NOT unwrap to os.ErrDeadlineExceeded")
	}
	if !writeDeadlineExceeded(timeout) {
		t.Error("an expired write deadline must be detected via the net.Error interface")
	}
	if retryableWriteError(timeout) {
		t.Error("an expired write deadline must be fatal, not retried like ENOBUFS")
	}

	// The converse: kernel backpressure is not a deadline expiry, so it must
	// still reach the retry ladder rather than closing the connection.
	enobufs := &net.OpError{Op: "writev", Net: "tcp",
		Err: os.NewSyscallError("writev", syscall.ENOBUFS)}
	if writeDeadlineExceeded(enobufs) {
		t.Error("ENOBUFS must not be classified as a write deadline expiry")
	}
	if !retryableWriteError(enobufs) {
		t.Error("ENOBUFS must still be retried")
	}
}

// TestWSUpgraderWriteBufferAvoidsFragmenting guards the write buffer against
// being shrunk back. gorilla fragments a compressed message once it outgrows
// this buffer, and fragmented compressed frames are the shape WebKit — every
// Juggler viewer — has trouble with. The exact size is a judgement call; being
// far above the 1 KiB that fragmented nearly every message is not.
func TestWSUpgraderWriteBufferAvoidsFragmenting(t *testing.T) {
	u := newWSUpgrader()
	if u.WriteBufferSize < 16*1024 {
		t.Errorf("WriteBufferSize = %d, want >= 16 KiB so ordinary messages ride one frame", u.WriteBufferSize)
	}
	if u.WriteBufferPool != nil {
		t.Error("WriteBufferPool costs a get/put per message; Juggler has few connections writing constantly")
	}
	if u.CheckOrigin == nil {
		t.Error("CheckOrigin must stay set — it is the same-origin gate on upgrades")
	}
}

// TestViewerListenerEnablesKeepAlive pins that the viewer-facing listener asks
// the kernel to probe idle connections, so a peer whose host vanished is
// reaped without anything at the application layer noticing. Asserts the
// configuration rather than observing probes: the settings are not readable
// back portably, and waiting for real probes would be a two-minute timing
// test. Binding proves the configuration is one the platform accepts.
func TestViewerListenerEnablesKeepAlive(t *testing.T) {
	cfg := viewerListenConfig.KeepAliveConfig
	if !cfg.Enable {
		t.Error("keep-alive probes must be enabled on the viewer listener")
	}
	if cfg.Idle <= 0 || cfg.Interval <= 0 || cfg.Count <= 0 {
		t.Errorf("keep-alive period must be explicit, not left to the platform default: %+v", cfg)
	}
	// A dead peer should be detected in minutes, not hours.
	if worst := cfg.Idle + cfg.Interval*time.Duration(cfg.Count); worst > 10*time.Minute {
		t.Errorf("worst-case dead-peer detection %s is too slow to be useful", worst)
	}

	ln, err := listenForViewers("127.0.0.1:0")
	if err != nil {
		t.Fatalf("listener rejected the keep-alive configuration: %v", err)
	}
	defer ln.Close()
}

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
