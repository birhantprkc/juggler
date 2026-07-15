//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

type fakeUsageProvider struct {
	name string
	err  error
}

func (p fakeUsageProvider) Name() string { return p.name }
func (p fakeUsageProvider) ListModelsWithInfo(context.Context) ([]provider.ModelInfo, error) {
	return nil, nil
}
func (p fakeUsageProvider) OpenConversation(context.Context, string) (provider.Conversation, error) {
	return nil, nil
}
func (p fakeUsageProvider) UsageStats(context.Context) (provider.UsageStats, error) {
	if p.err != nil {
		return provider.UsageStats{}, p.err
	}
	return provider.UsageStats{
		Provider:  p.name,
		Plan:      "test-plan",
		UpdatedAt: time.Unix(1000, 0).UTC(),
		Stats: []provider.UsageStat{{
			Name:        "Session (5h)",
			UsedPercent: provider.Pct(42),
			Category:    "primary",
		}},
	}, nil
}

func TestHandleProviderUsageStatsBestEffort(t *testing.T) {
	const okName = "testusage_ok"
	const errName = "testusage_err"
	provider.RegisterProvider(provider.ProviderInfo{Name: okName, AuthType: provider.AuthTypeToggle}, func(provider.Config) (provider.Provider, error) {
		return fakeUsageProvider{name: okName}, nil
	})
	provider.RegisterProvider(provider.ProviderInfo{Name: errName, AuthType: provider.AuthTypeToggle}, func(provider.Config) (provider.Provider, error) {
		return fakeUsageProvider{name: errName, err: errors.New("upstream unavailable")}, nil
	})

	userpathstest.Isolate(t)
	jugglerDir := userpaths.ConfigDir()
	if err := os.MkdirAll(jugglerDir, 0700); err != nil {
		t.Fatalf("mkdir credentials dir: %v", err)
	}
	creds := []byte(`{"enabled_testusage_ok":"true","enabled_testusage_err":"true"}`)
	if err := os.WriteFile(filepath.Join(jugglerDir, "credentials.json"), creds, 0600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/providers/usage", nil)
	rec := httptest.NewRecorder()
	(&Server{}).handleProviderUsageStats(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Usage  []provider.UsageStats `json:"usage"`
		Errors map[string]string     `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	var found *provider.UsageStats
	for i := range body.Usage {
		if body.Usage[i].Provider == okName {
			found = &body.Usage[i]
		}
	}
	if found == nil || found.Plan != "test-plan" || len(found.Stats) != 1 || found.Stats[0].UsedPercent == nil || *found.Stats[0].UsedPercent != 42 {
		t.Fatalf("missing expected usage for %s: %+v", okName, body.Usage)
	}
	if body.Errors[errName] != "upstream unavailable" {
		t.Fatalf("errors[%s] = %q", errName, body.Errors[errName])
	}
}
