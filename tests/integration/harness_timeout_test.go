package integration_test

import (
	"net"
	"testing"
	"time"

	"juggler/tests/helpers"
)

// acceptButNeverReply stands up a TCP listener that accepts every connection
// and then holds it open without ever writing an HTTP response — the exact
// shape of a server whose engine main thread has stalled (the macOS
// hidden-WebView hazard). Returns its address; the listener closes with t.
func acceptButNeverReply(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c // never reply; hold the connection
		}
	}()
	return ln.Addr().String()
}

// TestHarnessPollServerFailsFastOnWedgedServer guards the regression that made
// `make test` "get stuck": the harness HTTP helpers once used the default
// no-timeout client, so a wedged server (accepts the connection, never replies)
// blocked the polling goroutine forever. In the parallel phase that goroutine
// holds a testServerPool slot, so one wedged server hung the WHOLE suite until
// the outer 15-minute -timeout fired. pollServer must instead fail at its
// deadline so the per-test failure frees the slot and the run continues.
func TestHarnessPollServerFailsFastOnWedgedServer(t *testing.T) {
	addr := acceptButNeverReply(t)

	var out struct{ Passed bool }
	start := time.Now()
	// A bare address with no liveness record: this listener is not a pool
	// subprocess, and pollServer's death check tolerates a nil one.
	err := pollServer(testServerEntry{addr: addr}, "/api/test/result", 2*time.Second, &out)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("pollServer returned nil against a wedged server; expected a timeout error")
	}
	if elapsed > 6*time.Second {
		t.Fatalf("pollServer blocked %s past its 2s deadline — the no-timeout client "+
			"regression is back; a wedged server will hang the whole suite", elapsed)
	}
}

// TestHarnessWaitForServerFailsFastOnWedgedServer guards the same regression in
// the cold-start readiness poll (tests/helpers.WaitForServer).
func TestHarnessWaitForServerFailsFastOnWedgedServer(t *testing.T) {
	addr := acceptButNeverReply(t)

	start := time.Now()
	err := helpers.WaitForServer("http://"+addr, 2*time.Second)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("WaitForServer returned nil against a wedged server; expected a timeout error")
	}
	if elapsed > 6*time.Second {
		t.Fatalf("WaitForServer blocked %s past its 2s deadline — the no-timeout client "+
			"regression is back", elapsed)
	}
}
