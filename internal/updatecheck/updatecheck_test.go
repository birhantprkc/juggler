//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package updatecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		ok   bool
	}{
		{"v0.0.8", "v0.1.0", -1, true},
		{"0.0.8", "0.1.0", -1, true},
		{"v0.1.0", "v0.0.8", 1, true},
		{"v1.2.3", "v1.2.3", 0, true},
		{"v1.2", "v1.2.0", 0, true},
		{"v1.2.3-beta.1", "v1.2.3", 0, true}, // prerelease suffix ignored
		{"v2.0.0", "v10.0.0", -1, true},      // numeric, not lexical
		{"dev", "v0.1.0", 0, false},
		{"v0.1.0", "garbage", 0, false},
		{"", "v0.1.0", 0, false},
	}
	for _, c := range cases {
		got, ok := compareSemver(c.a, c.b)
		if got != c.want || ok != c.ok {
			t.Errorf("compareSemver(%q,%q) = (%d,%v), want (%d,%v)", c.a, c.b, got, ok, c.want, c.ok)
		}
	}
}

func TestComputeStatus(t *testing.T) {
	notice := &Notice{ID: "upgrade-0.1.0", Severity: "recommended", Title: "Update"}
	m := &Manifest{Schema: Schema, SchemaVersion: 1, Latest: "v0.1.0", Notice: notice}

	t.Run("older shows notice", func(t *testing.T) {
		st := ComputeStatus(m, "v0.0.8")
		if !st.UpdateAvailable || st.Notice == nil || st.Notice.ID != "upgrade-0.1.0" {
			t.Fatalf("expected update+notice, got %+v", st)
		}
		if st.LatestVersion != "v0.1.0" || st.CurrentVersion != "v0.0.8" {
			t.Errorf("version fields = %q/%q", st.CurrentVersion, st.LatestVersion)
		}
	})
	t.Run("equal shows nothing", func(t *testing.T) {
		st := ComputeStatus(m, "v0.1.0")
		if st.UpdateAvailable || st.Notice != nil {
			t.Fatalf("expected no update, got %+v", st)
		}
	})
	t.Run("newer shows nothing", func(t *testing.T) {
		st := ComputeStatus(m, "v0.2.0")
		if st.UpdateAvailable || st.Notice != nil {
			t.Fatalf("expected no update, got %+v", st)
		}
	})
	t.Run("dev build never nags", func(t *testing.T) {
		st := ComputeStatus(m, "dev")
		if st.UpdateAvailable || st.Notice != nil {
			t.Fatalf("dev should not update, got %+v", st)
		}
	})
	t.Run("nil manifest", func(t *testing.T) {
		st := ComputeStatus(nil, "v0.0.8")
		if st.UpdateAvailable || st.Notice != nil || st.CurrentVersion != "v0.0.8" {
			t.Fatalf("unexpected %+v", st)
		}
	})
}

func TestCheckOnce(t *testing.T) {
	const manifest = `{
		"schema": "juggler-version",
		"schemaVersion": 1,
		"latest": "v0.1.0",
		"notice": {"id": "upgrade-0.1.0", "severity": "recommended", "title": "Juggler 0.1.0"},
		"downloads": {"darwin/arm64": {"url": "https://example.com/x.dmg"}}
	}`

	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte(manifest))
	}))
	defer srv.Close()

	var changes []Status
	c := New(Config{
		URL:            srv.URL,
		CurrentVersion: "v0.0.8",
		OS:             "darwin",
		Arch:           "arm64",
		OnChange:       func(s Status) { changes = append(changes, s) },
	})

	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("CheckOnce: %v", err)
	}
	// Self-describing query params reached the server.
	for _, want := range []string{"v=v0.0.8", "os=darwin", "arch=arm64"} {
		if !contains(gotQuery, want) {
			t.Errorf("query %q missing %q", gotQuery, want)
		}
	}
	st := c.Current()
	if !st.UpdateAvailable || st.Notice == nil || st.Notice.ID != "upgrade-0.1.0" {
		t.Fatalf("status = %+v", st)
	}
	if len(changes) != 1 {
		t.Fatalf("OnChange fired %d times, want 1", len(changes))
	}

	// Second identical fetch must NOT re-fire OnChange (no change).
	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("CheckOnce#2: %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("OnChange fired %d times after stable fetch, want 1", len(changes))
	}
}

func TestCheckOnceRejectsForeignBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>captive portal</html>`))
	}))
	defer srv.Close()

	c := New(Config{URL: srv.URL, CurrentVersion: "v0.0.8"})
	if err := c.CheckOnce(context.Background()); err == nil {
		t.Fatal("expected error for non-manifest body")
	}
	if c.Current().UpdateAvailable {
		t.Fatal("foreign body must not flip updateAvailable")
	}
}

func TestCheckOnceRejectsBadSchema(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"schema":"something-else","schemaVersion":1,"latest":"v9.9.9"}`))
	}))
	defer srv.Close()

	c := New(Config{URL: srv.URL, CurrentVersion: "v0.0.8"})
	if err := c.CheckOnce(context.Background()); err == nil {
		t.Fatal("expected error for wrong schema")
	}
}

func TestCheckOnceNotModified(t *testing.T) {
	const manifest = `{"schema":"juggler-version","schemaVersion":1,"latest":"v0.1.0",
		"notice":{"id":"n1","severity":"info"}}`
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("If-None-Match") == `"etag1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"etag1"`)
		_, _ = w.Write([]byte(manifest))
	}))
	defer srv.Close()

	changes := 0
	c := New(Config{URL: srv.URL, CurrentVersion: "v0.0.8", OnChange: func(Status) { changes++ }})
	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := c.CheckOnce(context.Background()); err != nil {
		t.Fatalf("second: %v", err)
	}
	if hits != 2 {
		t.Fatalf("server hit %d times, want 2", hits)
	}
	if changes != 1 {
		t.Fatalf("OnChange fired %d times, want 1 (304 must not re-fire)", changes)
	}
	if !c.Current().UpdateAvailable {
		t.Fatal("304 must preserve last-good status")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
