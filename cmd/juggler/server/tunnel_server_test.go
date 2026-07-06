//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
)

const remoteEdgeAddr = "203.0.113.7:54321" // non-loopback, simulates a remote client

// withRemoteIngress tags a request as having arrived over an explicitly-granted
// remote transport, exactly as the http-over-DC dispatcher and a tunnel
// forwarder hop do.
func withRemoteIngress(r *http.Request) *http.Request {
	return MarkRemoteIngress(r, "test-transport")
}

// TestRemoteIngressBypassesLANGate verifies that requests tagged as remote
// ingress are admitted through the LAN gate even when public mode is off —
// the tag records the user's explicit grant of remote access (possession of an
// unguessable id plus a completed handshake, or an explicitly-started tunnel).
func TestRemoteIngressBypassesLANGate(t *testing.T) {
	var reached bool
	s := &Server{router: mux.NewRouter()}
	s.router.Use(s.lanGateMiddleware) // public mode defaults to off
	s.router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})

	// Sanity: an untagged non-loopback request is rejected when public mode is off.
	reqRemote := httptest.NewRequest(http.MethodGet, "/", nil)
	reqRemote.RemoteAddr = remoteEdgeAddr
	recRemote := httptest.NewRecorder()
	s.router.ServeHTTP(recRemote, reqRemote)
	if recRemote.Code != http.StatusForbidden {
		t.Fatalf("non-loopback remote: got %d, want 403", recRemote.Code)
	}
	if reached {
		t.Fatal("gate should have blocked the non-loopback request")
	}

	// Tagged as remote ingress, the same remote client is admitted.
	reached = false
	reqRv := withRemoteIngress(httptest.NewRequest(http.MethodGet, "/", nil))
	reqRv.RemoteAddr = remoteEdgeAddr
	recRv := httptest.NewRecorder()
	s.router.ServeHTTP(recRv, reqRv)
	if recRv.Code != http.StatusOK {
		t.Fatalf("remote ingress: got %d, want 200", recRv.Code)
	}
	if !reached {
		t.Fatal("remote ingress should have been admitted through the gate")
	}
}

// TestEngineRoleRejectsRemoteIngress is the security guard for remote
// transports: their requests reach the server looking loopback (an http-over-DC
// dispatch or a forwarder hop), so the engine WS role must be gated on the
// remote-ingress tag (and loopback), not loopback alone — otherwise a remote
// guest could overwrite the in-process engine.
func TestEngineRoleRejectsRemoteIngress(t *testing.T) {
	// Loopback, untagged → allowed (the in-process engine WebView).
	loopback := httptest.NewRequest(http.MethodGet, "/ws?role=engine", nil)
	loopback.RemoteAddr = "127.0.0.1:5000"
	if !engineRoleAllowed(loopback) {
		t.Fatal("loopback non-remote-ingress request should be allowed the engine role")
	}

	// Loopback BUT remote ingress → refused, despite looking loopback.
	tagged := withRemoteIngress(loopback)
	if engineRoleAllowed(tagged) {
		t.Fatal("remote ingress must NOT be allowed the engine role even though it is loopback")
	}

	// Non-loopback → refused regardless.
	remote := httptest.NewRequest(http.MethodGet, "/ws?role=engine", nil)
	remote.RemoteAddr = remoteEdgeAddr
	if engineRoleAllowed(remote) {
		t.Fatal("non-loopback request must not be allowed the engine role")
	}
}
