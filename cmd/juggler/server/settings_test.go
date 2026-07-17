//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/updatecheck"
	"juggler/internal/userpaths/userpathstest"
)

// manifestTestServer returns an httptest server serving a manifest advertising
// latest, plus a channel that receives once per request hit.
func manifestTestServer(t *testing.T, latest string) (*httptest.Server, chan struct{}) {
	t.Helper()
	hits := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- struct{}{}
		_, _ = w.Write([]byte(`{"schema":"juggler-version","schemaVersion":1,"latest":"` + latest +
			`","notice":{"id":"n1","severity":"info"}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, hits
}

func TestHandleGetSettingsDefault(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	rec := httptest.NewRecorder()
	s.handleGetSettings(rec, httptest.NewRequest("GET", "/api/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec.Code)
	}
	var gs core.GlobalSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &gs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gs.Updates.Mode != core.UpdateModeAutomatic {
		t.Fatalf("default mode = %q, want %q", gs.Updates.Mode, core.UpdateModeAutomatic)
	}
}

func TestHandlePutSettingsValid(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"updates":{"mode":"notify"}}`))
	s.handlePutSettings(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := s.updateMode(); got != core.UpdateModeNotify {
		t.Fatalf("mode after PUT = %q, want %q", got, core.UpdateModeNotify)
	}
	// Persisted: a fresh store reads it back.
	if gs, _ := core.LoadGlobalSettings(); gs.Updates.Mode != core.UpdateModeNotify {
		t.Fatalf("persisted mode = %q, want %q", gs.Updates.Mode, core.UpdateModeNotify)
	}
}

func TestHandlePutSettingsInvalidMode(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"updates":{"mode":"garbage"}}`))
	s.handlePutSettings(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode status = %d, want 400", rec.Code)
	}
	if got := s.updateMode(); got != core.UpdateModeAutomatic {
		t.Fatalf("mode after rejected PUT = %q, want unchanged automatic", got)
	}
}

func TestHandlePutSettingsOffToOnKicksCheck(t *testing.T) {
	userpathstest.Isolate(t)
	srv, hits := manifestTestServer(t, "v9.9.9")
	s := &Server{settings: newSettingsStore()}
	s.updateChecker = updatecheck.New(updatecheck.Config{
		URL:            srv.URL,
		CurrentVersion: "v0.0.1",
		Enabled:        func() bool { return s.updateMode() != core.UpdateModeOff },
	})

	// Start from off, then flip to automatic — that must kick an immediate check.
	if err := s.settings.set(core.GlobalSettings{Updates: core.UpdateSettings{Mode: core.UpdateModeOff}}); err != nil {
		t.Fatalf("seed off: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"updates":{"mode":"automatic"}}`))
	s.handlePutSettings(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d", rec.Code)
	}
	select {
	case <-hits:
	case <-time.After(3 * time.Second):
		t.Fatal("off→on did not kick an update check")
	}
}

func TestHandleManualUpdateCheckBypassesOff(t *testing.T) {
	userpathstest.Isolate(t)
	srv, hits := manifestTestServer(t, "v9.9.9")
	s := &Server{settings: newSettingsStore()}
	s.updateChecker = updatecheck.New(updatecheck.Config{
		URL:            srv.URL,
		CurrentVersion: "v0.0.1",
		Enabled:        func() bool { return s.updateMode() != core.UpdateModeOff },
	})
	if err := s.settings.set(core.GlobalSettings{Updates: core.UpdateSettings{Mode: core.UpdateModeOff}}); err != nil {
		t.Fatalf("seed off: %v", err)
	}

	rec := httptest.NewRecorder()
	s.handleManualUpdateCheck(rec, httptest.NewRequest("POST", "/api/update-status/check", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("manual check status = %d", rec.Code)
	}
	select {
	case <-hits:
	case <-time.After(3 * time.Second):
		t.Fatal("manual check must reach the server even while off")
	}
	var st updatecheck.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !st.UpdateAvailable {
		t.Fatalf("manual check should surface the available update, got %+v", st)
	}
}
