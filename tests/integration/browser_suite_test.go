//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"juggler/tests/helpers"
)

// harnessHTTPTimeout bounds every harness→server HTTP request. The default
// http client has NO timeout, so a server whose engine main thread has stalled
// (the macOS hidden-WebView CVDisplayLink hazard the architecture guards
// against) — accepting the TCP connection but never writing a reply — blocks
// the calling goroutine FOREVER. In the parallel phase that goroutine holds a
// testServerPool slot, so one wedged server starves every other lane and the
// whole suite hangs until the outer `make test` -timeout (15m) fires: the
// "stuck" symptom. The per-test PerTestTimeout watchdog can't rescue it (it
// only dumps a stack; FailNow from another goroutine is unsafe). Bounding each
// request converts an indefinite whole-suite hang into a single loud,
// attributable per-test failure that frees the slot so the run continues.
// 60s matches the per-test budget in runOneBrowserTest — a request still
// outstanding past it means the server is wedged, not slow.
const harnessHTTPTimeout = 60 * time.Second

// postConnectWindow bounds how long postToServer retries transport (dial)
// failures. A freshly-spawned pool server announces its address (JUGGLER_ADDR=)
// the instant it knows its port — which can be a beat before its HTTP listener
// is actually accepting, and on a loaded CI runner that gap is wider. Without a
// retry, that single "connection refused" fails the WHOLE suite before any test
// runs (the __list__ POST that gates test discovery goes through postToServer).
// A transport error means the request never reached the server, so re-sending
// is safe; a genuine boot crash still surfaces once this window elapses.
const postConnectWindow = 10 * time.Second

// listDiscoveryTimeout bounds the wait for the harness to enumerate its tests
// and POST them back to /api/test/names after the __list__ trigger. Unlike a
// per-test run — where the harness iframes are already loaded and connected —
// discovery is the FIRST thing the suite does, so it races a cold engine boot:
// the pool releases a slot token the instant the subprocess prints JUGGLER_ADDR=
// (HTTP listener up), which is well before the WebView2/WebKit host has loaded
// the test-pool page, brought up every iframe, and connected their sockets. On
// a loaded CI runner under `-race` that warm-up is slow (Windows especially),
// and a budget shorter than the boot budget makes discovery time out before the
// harness is ever ready — failing the whole suite. Match the 60s subprocess-boot
// and per-test budgets so discovery gets the same slack as everything else.
const listDiscoveryTimeout = 60 * time.Second

// TestBrowser runs all browser-side tests in parallel. Each JS test becomes a
// subtest addressable via -run, e.g. go test -run 'TestBrowser/integration:glob-go-files'.
//
// Each test acquires an isolated Wails subprocess+fixture from testServerPool so
// concurrent tests cannot interfere with each other's session state.
func TestBrowser(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping browser tests in short mode")
	}

	// Use any pool slot to fetch the test list (read-only, no fixture writes needed).
	srv := <-testServerPool
	names, exclusive, err := listBrowserTests(srv)
	testServerPool <- srv
	if err != nil {
		t.Fatalf("cannot list browser tests: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("browser returned empty test list")
	}

	// Wipe each pool slot's fixture (preserving .juggler/ session state) so
	// `-count=N` iterations don't see leftover test files from the prior
	// iteration ("Created file" vs "Updated file" mismatches, etc.). The
	// iframe-pool integration runner skips its per-test wipe because it
	// would clobber sibling tests' in-flight files; this once-per-iteration
	// reset is the safe equivalent that runs while no tests are in flight.
	resetAllFixtures(t)

	// After every subtest (including the parallel phase) completes: any
	// conversation still in the server's ownership ledger was created by a
	// test and never deleted. Leaks march the shared session toward the
	// MAX_CONVERSATIONS cap — the pressure behind the historical cross-lane
	// bulldoze flakes — so they fail the run loudly, named by creator lane.
	t.Cleanup(func() { reportLeakedConversations(t) })

	exclusiveSet := make(map[string]bool, len(exclusive))
	for _, p := range exclusive {
		exclusiveSet[p] = true
	}

	// Phase 1: tests that need the whole pool to themselves, one at a time with
	// no other test in flight. Two kinds qualify, both because they contend on
	// something the lanes share and cannot namespace per-test:
	//
	//   - Fixture-root polluters write a fixed-name file (e.g. CLAUDE.md) that
	//     production auto-detection scans on every createConversation. A fixed
	//     filename can't hide behind a per-test prefix, so a sibling lane's
	//     createConversation would pick it up.
	//   - Focus-sensitive tests assert on document.activeElement. Every lane is
	//     an iframe in ONE window, and a window has exactly one focused frame:
	//     any sibling calling element.focus() takes frame focus away, which
	//     blurs the asserting lane's element to <body>. That is a property of
	//     the pool topology, not of the code under test, so these tests are
	//     only meaningful with no sibling running.
	//
	// These run FIRST and synchronously (no t.Parallel): the parallel subtests
	// registered in phase 2 don't start until this parent function returns, so
	// no sibling is ever in flight here. Reset every fixture before each so a
	// previous polluter's file can't linger. Subtest names stay flat
	// (TestBrowser/<name>), preserving `-run` filters.
	for _, name := range names {
		if !exclusiveSet[name] {
			continue
		}
		name := name
		t.Run(name, func(t *testing.T) {
			resetAllFixtures(t)

			srv := <-testServerPool
			defer func() {
				testServerPool <- srv
			}()

			runOneBrowserTest(t, srv)
		})
	}

	// Reset once more before the parallel phase: a polluter that failed before
	// its own cleanup op could otherwise leave its fixed-name file behind for
	// every parallel lane to auto-detect.
	if len(exclusiveSet) > 0 {
		resetAllFixtures(t)
	}

	// Phase 2: every test that tolerates siblings, fanned across the pool in parallel.
	for _, name := range names {
		if exclusiveSet[name] {
			continue
		}
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv := <-testServerPool
			defer func() {
				testServerPool <- srv
			}()

			runOneBrowserTest(t, srv)
		})
	}
}

// resetAllFixtures POSTs /api/test/reset-fixture to every pool slot, wiping
// any files left over from a prior `-count` iteration. Drains the pool, hits
// each slot's reset endpoint, then re-fills the pool — runs while no tests
// are in flight so it's safe to clobber the shared fixture dir.
func resetAllFixtures(t *testing.T) {
	t.Helper()
	slots := make([]testServerEntry, 0, cap(testServerPool))
	for {
		select {
		case s := <-testServerPool:
			slots = append(slots, s)
		default:
			goto drained
		}
	}
drained:
	seen := make(map[string]bool, len(slots))
	for _, s := range slots {
		// Each (addr, fixture) pair shares one SessionManager — reset once per pair.
		key := s.addr + "|" + s.fixture
		if !seen[key] {
			seen[key] = true
			url := fmt.Sprintf("/api/test/reset-fixture?fixture=unit-test-fixture&dir=%s",
				neturlEscape(s.fixture))
			client := &http.Client{Timeout: harnessHTTPTimeout}
			resp, err := client.Post("http://"+s.addr+url, "application/json", nil)
			if err != nil {
				t.Fatalf("reset-fixture failed for %s: %v", s.addr, err)
			}
			resp.Body.Close()
			if resp.StatusCode >= 300 {
				t.Fatalf("reset-fixture %s returned %d", s.addr, resp.StatusCode)
			}
		}
		testServerPool <- s
	}
}

// reportLeakedConversations queries every pool server's test-mode ownership
// ledger and fails the run if any conversation created by a test still
// exists. Runs from TestBrowser's cleanup, after all subtests (and their
// lanes' own cleanup deletes) have finished, so anything still owned is a
// genuine leak — the entry's lane id plus the per-lane delete attribution in
// the server log identify the leaking test.
func reportLeakedConversations(t *testing.T) {
	t.Helper()
	slots := make([]testServerEntry, 0, cap(testServerPool))
	for {
		select {
		case s := <-testServerPool:
			slots = append(slots, s)
		default:
			goto drained
		}
	}
drained:
	seen := make(map[string]bool, len(slots))
	for _, s := range slots {
		if !seen[s.addr] {
			seen[s.addr] = true
			client := &http.Client{Timeout: harnessHTTPTimeout}
			resp, err := client.Get("http://" + s.addr + "/api/test/conversation-owners")
			if err != nil {
				t.Errorf("conversation-owners check failed for %s: %v", s.addr, err)
			} else {
				// A non-200 means the ownership endpoint is unwired — which
				// also means the cross-lane delete guard is unwired. Fail
				// loudly rather than letting the leak check pass vacuously
				// (that exact silent unwiring has happened: the sessionAPI
				// field was zeroed by a wholesale struct reassignment).
				if resp.StatusCode != http.StatusOK {
					t.Errorf("conversation-owners returned %d on %s — the ownership "+
						"guard/leak check is not wired; see RegisterTestRoutes", resp.StatusCode, s.addr)
				}
				var body struct {
					Owners map[string]struct {
						Lane   string `json:"lane"`
						Reason string `json:"reason"`
					} `json:"owners"`
				}
				if err := json.NewDecoder(resp.Body).Decode(&body); err == nil && len(body.Owners) > 0 {
					lines := make([]string, 0, len(body.Owners))
					for id, o := range body.Owners {
						reason := o.Reason
						if reason == "" {
							reason = "unknown test"
						}
						lines = append(lines, fmt.Sprintf("%s (created by %s, lane %s)", id, reason, o.Lane))
					}
					sort.Strings(lines)
					t.Errorf("LEAKED CONVERSATIONS on %s (created by a test, never deleted): %s — "+
						"these accumulate in the shared session toward the MAX_CONVERSATIONS cap; "+
						"the creating test must delete what it creates", s.addr, strings.Join(lines, "; "))
				}
				resp.Body.Close()
			}
		}
		testServerPool <- s
	}
}

// neturlEscape is a tiny inline url.QueryEscape stand-in to avoid pulling
// net/url just for one call site.
func neturlEscape(s string) string {
	const hex = "0123456789ABCDEF"
	var b []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' {
			b = append(b, c)
		} else {
			b = append(b, '%', hex[c>>4], hex[c&15])
		}
	}
	return string(b)
}

// listBrowserTests triggers list mode on the Wails subprocess and waits for the
// names to be POSTed back to /api/test/names. It returns every test name plus
// the subset that must run with no sibling in flight (run isolated; see the
// sequential phase in TestBrowser).
func listBrowserTests(srv testServerEntry) (names, exclusive []string, err error) {
	if err := postToServer(srv.addr, "/api/test/run", map[string]any{
		"name": "__list__",
	}); err != nil {
		return nil, nil, fmt.Errorf("POST __list__: %w", err)
	}

	var payload struct {
		Names     []string `json:"names"`
		Exclusive []string `json:"exclusive"`
	}
	if err := pollServer(srv.addr, "/api/test/names", listDiscoveryTimeout, &payload); err != nil {
		return nil, nil, fmt.Errorf("waiting for test names: %w", err)
	}
	return payload.Names, payload.Exclusive, nil
}

// runOneBrowserTest triggers one named test via the HTTP API and polls for its result.
func runOneBrowserTest(t *testing.T, srv testServerEntry) {
	name := t.Name()[len("TestBrowser/"):]

	// Per-test timeout enforced here; fail the test quickly rather than hanging.
	// A browser test normally completes in well under a second — anything still
	// running at a minute is wedged, not slow, so fail fast instead of hanging.
	const testTimeout = 60 * time.Second

	// Outer watchdog: dumps goroutines if the inner polling deadline somehow
	// doesn't fire (e.g. the goroutine running this test is itself stuck).
	helpers.PerTestTimeout(t, 2*testTimeout)

	// All iframes in a subprocess share the SessionManager's working dir
	// (srv.fixture) — the server-side path validator joins relative tool-
	// input paths against THAT, so a per-test scratch sub-dir wouldn't
	// actually isolate file IO. Tests collaborate on the shared fixture by
	// using unique filename prefixes (see comments at the top of every
	// *-tests.js file).
	if err := postToServer(srv.addr, "/api/test/run", map[string]any{
		"name":        name,
		"projectPath": srv.fixture,
	}); err != nil {
		t.Fatalf("POST test run: %v", err)
	}

	var result struct {
		Passed  bool     `json:"passed"`
		Details string   `json:"details"`
		Errors  []string `json:"errors"`
	}
	if err := pollServer(srv.addr, "/api/test/result?name="+name, testTimeout, &result); err != nil {
		t.Fatalf("waiting for test result: %v", err)
	}

	if !result.Passed {
		if len(result.Errors) > 0 {
			for _, e := range result.Errors {
				t.Error(e)
			}
		} else {
			t.Error(result.Details)
		}
	}
}

// postToServer sends a JSON POST to addr+path and returns on non-2xx.
//
// Transport (dial) errors are retried with a short backoff up to
// postConnectWindow: a pool server that has just printed its address may not be
// accepting connections for a few more milliseconds, and a single unretried
// "connection refused" on the __list__ POST fails the entire suite. A transport
// error means no request reached the server, so re-sending is safe and cannot
// double-apply. Once a response IS received (any status), we stop retrying — a
// non-2xx is a real server-side result, not a transient condition.
func postToServer(addr, path string, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: harnessHTTPTimeout}
	deadline := time.Now().Add(postConnectWindow)
	for {
		resp, err := client.Post("http://"+addr+path, "application/json", bytes.NewReader(data))
		if err != nil {
			// Transport failure: the request never landed. Retry until the
			// connect window closes, then surface the last error.
			if time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return fmt.Errorf("unexpected status %d", resp.StatusCode)
		}
		return nil
	}
}

// pollServer GET-polls addr+path every 200 ms until 200 OK is returned and the
// response JSON decodes successfully into out, or until timeout elapses. Each
// GET is bounded by the poll budget so a wedged server (one that accepts the
// connection but never replies) can't block past `timeout` — see
// harnessHTTPTimeout.
func pollServer(addr, path string, timeout time.Duration, out any) error {
	client := &http.Client{Timeout: timeout}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get("http://" + addr + path)
		if err == nil {
			if resp.StatusCode == http.StatusOK {
				decErr := json.NewDecoder(resp.Body).Decode(out)
				resp.Body.Close()
				if decErr == nil {
					return nil
				}
			} else {
				resp.Body.Close()
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("timeout polling %s after %s", path, timeout)
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
