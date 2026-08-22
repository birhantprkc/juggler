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
	"juggler/cmd/juggler/providers/provider"
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

// putSettings issues a PUT /api/settings with body and asserts the status code.
func putSettings(t *testing.T, s *Server, body string, wantCode int) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handlePutSettings(rec, httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body)))
	if rec.Code != wantCode {
		t.Fatalf("PUT %s: status = %d, want %d (body %s)", body, rec.Code, wantCode, rec.Body.String())
	}
}

func TestHandlePutSettingsMergesConnectivityAndUpdates(t *testing.T) {
	userpathstest.Isolate(t)
	withTestTunnelModes(t, TunnelModeSpec{Mode: "p2p", New: func(TunnelHost) TunnelProvider { return nil }})
	s := &Server{settings: newSettingsStore()}

	// A partial PUT must merge, not replace: setting one section leaves the other
	// untouched. Set updates, then connectivity, and confirm both persist.
	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	putSettings(t, s, `{"connectivity":{"lanOnLaunch":true,"wanOnLaunch":"p2p"}}`, http.StatusOK)

	gs := s.settings.get()
	if gs.Updates.Mode != core.UpdateModeNotify {
		t.Fatalf("updates clobbered by connectivity PUT: mode=%q", gs.Updates.Mode)
	}
	if !gs.Connectivity.LANOnLaunch || gs.Connectivity.WANOnLaunch != "p2p" {
		t.Fatalf("connectivity not saved: %+v", gs.Connectivity)
	}

	// A later updates-only PUT must not wipe the connectivity section.
	putSettings(t, s, `{"updates":{"mode":"off"}}`, http.StatusOK)
	if gs := s.settings.get(); !gs.Connectivity.LANOnLaunch || gs.Connectivity.WANOnLaunch != "p2p" {
		t.Fatalf("connectivity clobbered by later updates PUT: %+v", gs.Connectivity)
	}
}

func TestHandlePutSettingsInvalidWANMode(t *testing.T) {
	userpathstest.Isolate(t)
	withTestTunnelModes(t, TunnelModeSpec{Mode: "p2p", New: func(TunnelHost) TunnelProvider { return nil }})
	s := &Server{settings: newSettingsStore()}
	putSettings(t, s, `{"connectivity":{"wanOnLaunch":"p2p"}}`, http.StatusOK)

	// An unregistered mode is rejected with 400 and the stored value is unchanged.
	putSettings(t, s, `{"connectivity":{"wanOnLaunch":"bogus"}}`, http.StatusBadRequest)
	if got := s.settings.get().Connectivity.WANOnLaunch; got != "p2p" {
		t.Fatalf("rejected PUT changed wanOnLaunch to %q, want unchanged p2p", got)
	}
}

func TestHandlePutSettingsHiddenModelsRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-hidden-models-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		testMode:        true,
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}

	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["b-model","a-model","a-model"]}}}`, http.StatusOK)
	gs := s.settings.get()
	// Stored de-duplicated and sorted, so the file is stable across saves.
	if got := gs.Models.Hidden[providerName]; len(got) != 2 || got[0] != "a-model" || got[1] != "b-model" {
		t.Fatalf("hidden after PUT = %v, want [a-model b-model]", got)
	}
	if !gs.IsModelHidden(providerName, "a-model") {
		t.Fatal("IsModelHidden = false after hiding")
	}

	// GET reflects it.
	rec := httptest.NewRecorder()
	s.handleGetSettings(rec, httptest.NewRequest("GET", "/api/settings", nil))
	var out core.GlobalSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Models.Hidden[providerName]) != 2 {
		t.Fatalf("GET hidden = %v, want two entries", out.Models.Hidden[providerName])
	}

	// Un-hiding is an explicit empty array. Merging into a non-nil map cannot
	// express a deletion by omission, so this is the only gesture that clears it.
	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":[]}}}`, http.StatusOK)
	if got := s.settings.get().Models.Hidden[providerName]; len(got) != 0 {
		t.Fatalf("hidden after clearing = %v, want empty", got)
	}
}

func TestHandlePutSettingsHiddenModelsMergePreservesOtherSections(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-hidden-merge-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		testMode:        true,
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}

	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["a-model"]}}}`, http.StatusOK)
	if got := s.settings.get().Updates.Mode; got != core.UpdateModeNotify {
		t.Fatalf("updates clobbered by models PUT: mode=%q", got)
	}
	// And a later updates-only PUT must not wipe the hidden list.
	putSettings(t, s, `{"updates":{"mode":"off"}}`, http.StatusOK)
	if got := s.settings.get().Models.Hidden[providerName]; len(got) != 1 || got[0] != "a-model" {
		t.Fatalf("hidden clobbered by later updates PUT: %v", got)
	}
}

func TestHandlePutSettingsUnknownProviderRejected(t *testing.T) {
	userpathstest.Isolate(t)
	const providerName = "settings-hidden-reject-provider"
	provider.RegisterProvider(provider.ProviderInfo{Name: providerName}, func(provider.Config) (provider.Provider, error) {
		return nil, nil
	})
	s := &Server{
		settings:        newSettingsStore(),
		testMode:        true,
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
	}
	putSettings(t, s, `{"models":{"hidden":{"`+providerName+`":["a-model"]}}}`, http.StatusOK)

	// A provider this build doesn't register is rejected, and nothing is stored.
	putSettings(t, s, `{"models":{"hidden":{"nosuchprovider":["x"]}}}`, http.StatusBadRequest)
	gs := s.settings.get()
	if _, ok := gs.Models.Hidden["nosuchprovider"]; ok {
		t.Fatal("rejected PUT stored an unknown provider key")
	}
	if got := gs.Models.Hidden[providerName]; len(got) != 1 || got[0] != "a-model" {
		t.Fatalf("rejected PUT disturbed the valid list: %v", got)
	}
}

func TestSameHiddenModels(t *testing.T) {
	a := map[string][]string{"p": {"x", "y"}}
	if !sameHiddenModels(a, map[string][]string{"p": {"x", "y"}}) {
		t.Error("identical maps reported different")
	}
	if sameHiddenModels(a, map[string][]string{"p": {"x"}}) {
		t.Error("shorter list reported same")
	}
	if sameHiddenModels(a, map[string][]string{"p": {"x", "y"}, "q": {"z"}}) {
		t.Error("extra provider reported same")
	}
	if sameHiddenModels(a, map[string][]string{"q": {"x", "y"}}) {
		t.Error("different provider key reported same")
	}
	if !sameHiddenModels(nil, map[string][]string{}) {
		t.Error("nil and empty must compare equal")
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
