//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"testing"
	"time"
)

func floatPtr(v float64) *float64 { return &v }

func derefPct(p *float64) float64 {
	if p == nil {
		return -1
	}
	return *p
}

func TestBuildUsageStatsParsesWindows(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	stats := buildUsageStats(usageResponse{
		PlanType: "plus",
		RateLimit: usageRateLimit{
			PrimaryWindow:   usageWindow{UsedPercent: floatPtr(39.5), ResetAt: 2000, LimitWindowSeconds: 18_000},
			SecondaryWindow: usageWindow{UsedPercent: floatPtr(15), ResetAt: 3000, LimitWindowSeconds: 604_800},
		},
		AdditionalRateLimit: []additionalRateLimit{{
			LimitName: "gpt-5.3-codex",
			RateLimit: usageRateLimit{
				PrimaryWindow:   usageWindow{UsedPercent: floatPtr(7), ResetAt: 4000},
				SecondaryWindow: usageWindow{UsedPercent: floatPtr(8), ResetAt: 5000},
			},
		}},
		CodeReviewRateLimit: usageRateLimit{
			PrimaryWindow: usageWindow{UsedPercent: floatPtr(2), ResetAt: 6000},
		},
	}, now)

	if stats.Provider != "openaicodex" || stats.Plan != "plus" || !stats.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected stats header: %+v", stats)
	}
	if len(stats.Stats) != 5 {
		t.Fatalf("got %d stats, want 5: %+v", len(stats.Stats), stats.Stats)
	}
	assertStat := func(i int, name, category string, pct float64, reset int64, windowSecs int) {
		t.Helper()
		st := stats.Stats[i]
		if st.Name != name || st.Category != category || derefPct(st.UsedPercent) != pct || st.WindowSecs != windowSecs {
			t.Fatalf("stat[%d] = %+v", i, st)
		}
		if st.ResetsAt == nil || st.ResetsAt.Unix() != reset {
			t.Fatalf("stat[%d].ResetsAt = %v, want unix %d", i, st.ResetsAt, reset)
		}
	}
	assertStat(0, "Session (5h)", "primary", 39.5, 2000, 18_000)
	assertStat(1, "Week (7d)", "weekly", 15, 3000, 604_800)
	assertStat(2, "gpt-5.3-codex (5h)", "model", 7, 4000, 0)
	assertStat(3, "gpt-5.3-codex (7d)", "model", 8, 5000, 0)
	assertStat(4, "Code Review", "code_review", 2, 6000, 0)
}

func TestBuildUsageStatsSkipsAbsentWindows(t *testing.T) {
	stats := buildUsageStats(usageResponse{
		RateLimit: usageRateLimit{
			PrimaryWindow: usageWindow{UsedPercent: floatPtr(0)},
			// nil UsedPercent means upstream omitted the window, not 0%.
			SecondaryWindow: usageWindow{},
		},
		CodeReviewRateLimit: usageRateLimit{PrimaryWindow: usageWindow{}},
	}, time.Unix(0, 0))
	if len(stats.Stats) != 1 {
		t.Fatalf("got %d stats, want 1: %+v", len(stats.Stats), stats.Stats)
	}
	if stats.Stats[0].Name != "Session (5h)" || derefPct(stats.Stats[0].UsedPercent) != 0 {
		t.Fatalf("unexpected stat: %+v", stats.Stats[0])
	}
}
