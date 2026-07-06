//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func floatPtr(v float64) *float64 { return &v }
func intPtr(v int) *int           { return &v }
func int64Ptr(v int64) *int64     { return &v }

func derefPct(p *float64) float64 {
	if p == nil {
		return -1
	}
	return *p
}

func TestBuildUsageStatsParsesWindows(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	stats := buildUsageStats(usageResponse{
		Data: usageData{
			Level: "pro",
			Limits: []usageLimit{
				{Type: "TOKENS_LIMIT", Unit: intPtr(3), Number: intPtr(5), Percentage: floatPtr(40.5), NextResetTime: int64Ptr(2_000_000)},
				{Type: "TOKENS_LIMIT", Unit: intPtr(6), Number: intPtr(1), Percentage: floatPtr(52)},
				{Type: "TIME_LIMIT", Percentage: floatPtr(12.3)},
			},
		},
	}, now)

	if stats.Provider != "zai" || stats.Plan != "Pro" || !stats.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected stats header: %+v", stats)
	}
	if len(stats.Stats) != 3 {
		t.Fatalf("got %d stats, want 3: %+v", len(stats.Stats), stats.Stats)
	}
	assertStat := func(i int, name, category string, pct float64, windowSecs int) {
		t.Helper()
		st := stats.Stats[i]
		if st.Name != name || st.Category != category || derefPct(st.UsedPercent) != pct || st.WindowSecs != windowSecs {
			t.Fatalf("stat[%d] = %+v", i, st)
		}
	}
	// The 5h and weekly windows share type TOKENS_LIMIT; unit/number tell them apart.
	assertStat(0, "Session (5h)", "primary", 40.5, fiveHourWindowSecs)
	assertStat(1, "Week (7d)", "weekly", 52, weeklyWindowSecs)
	assertStat(2, "MCP (1 month)", "model", 12.3, 0)

	if stats.Stats[0].ResetsAt == nil || !stats.Stats[0].ResetsAt.Equal(time.UnixMilli(2_000_000).UTC()) {
		t.Fatalf("stat[0].ResetsAt = %v, want %v", stats.Stats[0].ResetsAt, time.UnixMilli(2_000_000).UTC())
	}
	if stats.Stats[1].ResetsAt != nil {
		t.Fatalf("stat[1].ResetsAt = %v, want nil (no nextResetTime)", stats.Stats[1].ResetsAt)
	}
}

func TestBuildUsageStatsUnknownTokenWindowStaysDistinct(t *testing.T) {
	stats := buildUsageStats(usageResponse{
		Data: usageData{Limits: []usageLimit{
			{Type: "TOKENS_LIMIT", Unit: intPtr(3), Number: intPtr(5), Percentage: floatPtr(10)},
			{Type: "TOKENS_LIMIT", Unit: intPtr(9), Number: intPtr(2), Percentage: floatPtr(20)},
		}},
	}, time.Unix(0, 0))
	if len(stats.Stats) != 2 {
		t.Fatalf("got %d stats, want 2: %+v", len(stats.Stats), stats.Stats)
	}
	// An unrecognised unit/number combo must not collapse onto another window.
	if stats.Stats[0].Name == stats.Stats[1].Name {
		t.Fatalf("windows collapsed to same name: %+v", stats.Stats)
	}
	if stats.Stats[1].Name != "Tokens (unit=9, number=2)" {
		t.Fatalf("unexpected fallback name: %q", stats.Stats[1].Name)
	}
}

func TestBuildUsageStatsSkipsAbsentPercentage(t *testing.T) {
	stats := buildUsageStats(usageResponse{
		Data: usageData{Limits: []usageLimit{
			{Type: "TOKENS_LIMIT", Unit: intPtr(3), Number: intPtr(5), Percentage: floatPtr(0)},
			// nil percentage means upstream omitted the window, not 0%.
			{Type: "TIME_LIMIT"},
		}},
	}, time.Unix(0, 0))
	if len(stats.Stats) != 1 {
		t.Fatalf("got %d stats, want 1: %+v", len(stats.Stats), stats.Stats)
	}
	if stats.Stats[0].Name != "Session (5h)" || derefPct(stats.Stats[0].UsedPercent) != 0 {
		t.Fatalf("unexpected stat: %+v", stats.Stats[0])
	}
}

func TestBuildUsageStatsFallsBackToTopLevelFields(t *testing.T) {
	stats := buildUsageStats(usageResponse{
		Level:  "lite",
		Limits: []usageLimit{{Type: "TOKENS_LIMIT", Unit: intPtr(3), Number: intPtr(5), Percentage: floatPtr(7)}},
	}, time.Unix(0, 0))
	if stats.Plan != "Lite" {
		t.Fatalf("plan = %q, want Lite", stats.Plan)
	}
	if len(stats.Stats) != 1 || derefPct(stats.Stats[0].UsedPercent) != 7 {
		t.Fatalf("unexpected stats: %+v", stats.Stats)
	}
}

func TestUsageStatsSendsRawAuthAndParses(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"level":"pro","limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":33.3}]}}`))
	}))
	defer srv.Close()

	orig := usageEndpoint
	usageEndpoint = srv.URL + "/api/monitor/usage/quota/limit"
	defer func() { usageEndpoint = orig }()

	stats, err := usageStats(context.Background(), "secret-key", nil)
	if err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	if gotAuth != "secret-key" {
		t.Fatalf("Authorization = %q, want raw key with no Bearer prefix", gotAuth)
	}
	if gotPath != "/api/monitor/usage/quota/limit" {
		t.Fatalf("path = %q", gotPath)
	}
	if stats.Plan != "Pro" {
		t.Fatalf("plan = %q, want Pro", stats.Plan)
	}
	if len(stats.Stats) != 1 || derefPct(stats.Stats[0].UsedPercent) != 33.3 || stats.Stats[0].Name != "Session (5h)" {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}
