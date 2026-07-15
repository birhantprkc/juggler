//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

const testAPIToken = "test-instance-token-abc123"

// newAuthTestServer builds a minimal non-test-mode server whose router carries
// only the api-auth middleware, plus a gated /api/ops/call, an exempt
// /api/health, and a non-/api "/" — enough to exercise every branch of the
// token + Host allowlist without standing up the full New() machinery.
func newAuthTestServer(t *testing.T) (*Server, *bool) {
	t.Helper()
	var reached bool
	s := &Server{router: mux.NewRouter(), apiToken: testAPIToken}
	s.router.Use(s.apiAuthMiddleware)
	hit := func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}
	s.router.HandleFunc("/api/ops/call", hit).Methods("POST")
	s.router.HandleFunc("/api/health", hit).Methods("GET")
	s.router.HandleFunc("/api/session/window-state", hit).Methods("GET", "PUT")
	s.router.HandleFunc("/api/session/conversations/{convId}/assets/{sha}", hit).Methods("GET")
	s.router.HandleFunc("/", hit).Methods("GET")
	return s, &reached
}

// TestAPIAuthRejectsUntokenedOpsCall is the core §S assertion: a cross-site page
// POSTing to /api/ops/call without the per-instance token is rejected with 401
// and never reaches the handler — closing the localhost cross-site RCE vector.
func TestAPIAuthRejectsUntokenedOpsCall(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "localhost" // isolate the token check from the Host check
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("untokened ops/call: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for an untokened ops/call")
	}
}

func TestAPIAuthRejectsWrongToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "localhost"
	req.Header.Set("X-Juggler-Token", "not-the-real-token")
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-token ops/call: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for a wrong-token ops/call")
	}
}

func TestAPIAuthAllowsCorrectToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "localhost"
	req.Header.Set("X-Juggler-Token", testAPIToken)
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("correctly-tokened ops/call: got %d, want 200", rec.Code)
	}
	if !*reached {
		t.Fatal("handler must run for a correctly-tokened, same-host ops/call")
	}
}

// TestAPIAuthAssetGetAcceptsQueryToken covers the <img src> path: an asset GET
// carries no X-Juggler-Token header (image loads can't set one), so the token
// rides as a ?token= query param and is accepted for this read-only route.
func TestAPIAuthAssetGetAcceptsQueryToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	const sha = "82203b2013a5381d5f1ae5ec3f85a0edf91bb7e65a82a91684a9aa1fc53e9da9"
	req := httptest.NewRequest(http.MethodGet, "/api/session/conversations/conv_x/assets/"+sha+"?token="+testAPIToken, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("query-token asset GET: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestAPIAuthAssetGetRejectsMissingToken confirms the query-param relaxation is
// still a gate: an asset GET with neither header nor ?token= is rejected 401.
func TestAPIAuthAssetGetRejectsMissingToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	const sha = "82203b2013a5381d5f1ae5ec3f85a0edf91bb7e65a82a91684a9aa1fc53e9da9"
	req := httptest.NewRequest(http.MethodGet, "/api/session/conversations/conv_x/assets/"+sha, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("untokened asset GET: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for an untokened asset GET")
	}
}

// TestAPIAuthQueryTokenIgnoredOffAssetRoute confirms the ?token= fallback is
// scoped to the asset route only: a POST /api/ops/call with the token in the
// query string (but no header) is still rejected, preserving the header-only
// gate — and its forced CORS preflight — on the sensitive tool surface.
func TestAPIAuthQueryTokenIgnoredOffAssetRoute(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call?token="+testAPIToken, nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("query-token ops/call: got %d, want 401", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for a query-token-only ops/call")
	}
}

// TestAPIAuthRejectsRebindingHost covers §S.2: even with a valid token, a Host
// header naming a DNS name (as a DNS-rebinding attacker's page would send) is
// rejected before the token is even consulted.
func TestAPIAuthRejectsRebindingHost(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "attacker.com" // a name, not localhost or an IP literal
	req.Header.Set("X-Juggler-Token", testAPIToken)
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("rebinding host: got %d, want 403", rec.Code)
	}
	if *reached {
		t.Fatal("handler must not run for a disallowed Host")
	}
}

func TestAPIAuthAllowsIPHost(t *testing.T) {
	s, reached := newAuthTestServer(t)

	for _, host := range []string{"127.0.0.1:8317", "localhost:8317", "192.168.1.5:8317", "[::1]:8317"} {
		*reached = false
		req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
		req.Host = host
		req.Header.Set("X-Juggler-Token", testAPIToken)
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !*reached {
			t.Fatalf("host %q: got %d reached=%v, want 200 reached=true", host, rec.Code, *reached)
		}
	}
}

// TestAPIAuthExemptEndpointsSkipToken confirms cross-process discovery endpoints
// (probed by peers that cannot know this instance's token) stay reachable.
func TestAPIAuthExemptEndpointsSkipToken(t *testing.T) {
	s, reached := newAuthTestServer(t)

	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/health"},
		{http.MethodGet, "/api/session/window-state"},
		{http.MethodPut, "/api/session/window-state"},
	} {
		*reached = false
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK || !*reached {
			t.Fatalf("exempt %s %s: got %d reached=%v, want 200 reached=true", tc.method, tc.path, rec.Code, *reached)
		}
	}
}

func TestAPIAuthIgnoresNonAPIPaths(t *testing.T) {
	s, reached := newAuthTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "example.com" // static assets are not Host-gated
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("non-/api path: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestAPIAuthTestModeBypass confirms the gate is inert in test mode so the
// browser integration harness (many synthetic origins) is unaffected.
func TestAPIAuthTestModeBypass(t *testing.T) {
	s, reached := newAuthTestServer(t)
	s.testMode = true

	req := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	req.Host = "attacker.com"
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !*reached {
		t.Fatalf("test-mode bypass: got %d reached=%v, want 200 reached=true", rec.Code, *reached)
	}
}

// TestServedEngineCarriesTokenForWorkerAPIFetches guards the production-only
// regression where /engine booted a module worker with no token. Browser tests
// run with s.testMode=true (auth disabled), so they still passed while real
// engine-side registry/config and fallback/background bash ops hit /api without
// X-Juggler-Token and wedged the tool lifecycle.
func TestServedEngineCarriesTokenForWorkerAPIFetches(t *testing.T) {
	s := &Server{apiToken: testAPIToken, staticVersion: "test-static-version"}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/engine", nil)
	s.serveEngine(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("serveEngine: got %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "window.__jugglerToken = '"+testAPIToken+"';") {
		t.Fatalf("engine page must embed API token for its worker-side /api fetches; body was:\n%s", body)
	}
	if !strings.Contains(body, "window.JUGGLER_ENGINE = true;") {
		t.Fatalf("engine page lost engine role marker; body was:\n%s", body)
	}
}

func TestEngineWorkerRuntimeInstallsTokenFetchShim(t *testing.T) {
	root, err := FindProjectRoot("")
	if err != nil {
		t.Fatalf("FindProjectRoot: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(root, "web", "js", "engine-worker-runtime.js"))
	if err != nil {
		t.Fatalf("read engine-worker-runtime.js: %v", err)
	}
	src := string(body)
	for _, want := range []string{
		"function installAPITokenFetchShim(token)",
		"headers.set('X-Juggler-Token', token)",
		"installAPITokenFetchShim(",
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("engine worker runtime missing %q", want)
		}
	}
}

// TestHostAllowedRemoteIngressBypass covers the remote-grant carve-out: a
// remote-transport request names an arbitrary Host but is admitted on its
// ingress tag (the token remains its authenticator).
func TestHostAllowedRemoteIngressBypass(t *testing.T) {
	base := httptest.NewRequest(http.MethodPost, "/api/ops/call", nil)
	base.Host = "abc123.trycloudflare.com"
	if hostAllowed(base) {
		t.Fatal("untagged tunnel-hostname request should fail hostAllowed")
	}
	if !hostAllowed(withRemoteIngress(base)) {
		t.Fatal("remote-ingress request should pass hostAllowed regardless of Host")
	}
}
