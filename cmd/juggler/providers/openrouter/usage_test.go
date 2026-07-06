//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func floatPtr(v float64) *float64 { return &v }

func TestBuildFromCreditsWithPool(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	stats := buildFromCredits(creditsData{TotalCredits: 20, TotalUsage: 5}, now)
	if stats.Provider != "openrouter" || !stats.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected header: %+v", stats)
	}
	if len(stats.Stats) != 1 {
		t.Fatalf("got %d stats, want 1: %+v", len(stats.Stats), stats.Stats)
	}
	st := stats.Stats[0]
	if st.Name != "Credits" || st.Category != "balance" || st.Detail != "$15.00 of $20.00 left" {
		t.Fatalf("unexpected stat: %+v", st)
	}
	if st.UsedPercent == nil || *st.UsedPercent != 25 {
		t.Fatalf("UsedPercent = %v, want 25", st.UsedPercent)
	}
}

func TestBuildFromCreditsPayAsYouGo(t *testing.T) {
	// No purchased pool: show cumulative spend, no meter.
	stats := buildFromCredits(creditsData{TotalCredits: 0, TotalUsage: 7.5}, time.Unix(0, 0))
	st := stats.Stats[0]
	if st.Name != "Usage" || st.Detail != "$7.50 used" {
		t.Fatalf("unexpected stat: %+v", st)
	}
	if st.UsedPercent != nil {
		t.Fatalf("UsedPercent = %v, want nil", *st.UsedPercent)
	}
}

func TestBuildFromKeyWithLimit(t *testing.T) {
	stats := buildFromKey(keyData{Usage: 3, Limit: floatPtr(10), LimitRemaining: floatPtr(7), IsFreeTier: false}, time.Unix(0, 0))
	st := stats.Stats[0]
	if stats.Plan != "" {
		t.Fatalf("plan = %q, want empty", stats.Plan)
	}
	if st.Name != "Credits" || st.Detail != "$7.00 of $10.00 left" {
		t.Fatalf("unexpected stat: %+v", st)
	}
	if st.UsedPercent == nil || *st.UsedPercent != 30 {
		t.Fatalf("UsedPercent = %v, want 30", st.UsedPercent)
	}
}

func TestBuildFromKeyFreeTierNoLimit(t *testing.T) {
	stats := buildFromKey(keyData{Usage: 1.25, Limit: nil, IsFreeTier: true}, time.Unix(0, 0))
	if stats.Plan != "Free" {
		t.Fatalf("plan = %q, want Free", stats.Plan)
	}
	st := stats.Stats[0]
	if st.Name != "Usage" || st.Detail != "$1.25 used" || st.UsedPercent != nil {
		t.Fatalf("unexpected stat: %+v", st)
	}
}

func TestUsageStatsPrefersCreditsAndSendsBearer(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"total_credits":20,"total_usage":5}}`))
	}))
	defer srv.Close()

	origC, origK := creditsURL, keyURL
	creditsURL, keyURL = srv.URL+"/credits", srv.URL+"/auth/key"
	defer func() { creditsURL, keyURL = origC, origK }()

	stats, err := usageStats(context.Background(), "secret-key", nil)
	if err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	if gotAuth != "Bearer secret-key" {
		t.Fatalf("Authorization = %q, want Bearer secret-key", gotAuth)
	}
	if gotPath != "/credits" {
		t.Fatalf("path = %q, want /credits", gotPath)
	}
	if len(stats.Stats) != 1 || stats.Stats[0].Detail != "$15.00 of $20.00 left" {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestUsageStatsFallsBackToKeyWhenCreditsGated(t *testing.T) {
	var hitKey bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/credits" {
			w.WriteHeader(http.StatusUnauthorized) // gated to a management key
			return
		}
		hitKey = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"usage":3,"limit":10,"limit_remaining":7,"is_free_tier":false}}`))
	}))
	defer srv.Close()

	origC, origK := creditsURL, keyURL
	creditsURL, keyURL = srv.URL+"/credits", srv.URL+"/auth/key"
	defer func() { creditsURL, keyURL = origC, origK }()

	stats, err := usageStats(context.Background(), "secret-key", nil)
	if err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	if !hitKey {
		t.Fatal("expected fallback to /auth/key after /credits was gated")
	}
	if len(stats.Stats) != 1 || stats.Stats[0].Detail != "$7.00 of $10.00 left" {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}
