//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBuildUsageStatsSingleCurrency(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	stats := buildUsageStats(balanceResponse{
		IsAvailable: true,
		BalanceInfos: []balanceInfo{
			{Currency: "USD", TotalBalance: "12.34"},
		},
	}, now)

	if stats.Provider != "deepseek" || !stats.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected header: %+v", stats)
	}
	if len(stats.Stats) != 1 {
		t.Fatalf("got %d stats, want 1: %+v", len(stats.Stats), stats.Stats)
	}
	st := stats.Stats[0]
	if st.Name != "Balance" || st.Category != "balance" || st.Detail != "$12.34 left" {
		t.Fatalf("unexpected stat: %+v", st)
	}
	// A balance has no meter.
	if st.UsedPercent != nil {
		t.Fatalf("UsedPercent = %v, want nil for a raw balance", *st.UsedPercent)
	}
}

func TestBuildUsageStatsMultiCurrencyNamesAndSymbols(t *testing.T) {
	stats := buildUsageStats(balanceResponse{
		BalanceInfos: []balanceInfo{
			{Currency: "USD", TotalBalance: "5.00"},
			{Currency: "CNY", TotalBalance: "110.00"},
			{Currency: "GBP", TotalBalance: "3.50"},
		},
	}, time.Unix(0, 0))

	if len(stats.Stats) != 3 {
		t.Fatalf("got %d stats, want 3: %+v", len(stats.Stats), stats.Stats)
	}
	want := []struct{ name, detail string }{
		{"Balance (USD)", "$5.00 left"},
		{"Balance (CNY)", "¥110.00 left"},
		{"Balance (GBP)", "3.50 GBP left"}, // unknown currency falls back to a trailing code
	}
	for i, w := range want {
		if stats.Stats[i].Name != w.name || stats.Stats[i].Detail != w.detail {
			t.Fatalf("stat[%d] = %+v, want name=%q detail=%q", i, stats.Stats[i], w.name, w.detail)
		}
	}
}

func TestBuildUsageStatsSkipsUnparseableBalance(t *testing.T) {
	stats := buildUsageStats(balanceResponse{
		BalanceInfos: []balanceInfo{{Currency: "USD", TotalBalance: "not-a-number"}},
	}, time.Unix(0, 0))
	if len(stats.Stats) != 0 {
		t.Fatalf("got %d stats, want 0: %+v", len(stats.Stats), stats.Stats)
	}
}

func TestUsageStatsSendsBearerAndParses(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"42.00"}]}`))
	}))
	defer srv.Close()

	orig := usageEndpoint
	usageEndpoint = srv.URL + "/user/balance"
	defer func() { usageEndpoint = orig }()

	stats, err := usageStats(context.Background(), "secret-key", nil)
	if err != nil {
		t.Fatalf("usageStats: %v", err)
	}
	if gotAuth != "Bearer secret-key" {
		t.Fatalf("Authorization = %q, want Bearer secret-key", gotAuth)
	}
	if gotPath != "/user/balance" {
		t.Fatalf("path = %q", gotPath)
	}
	if len(stats.Stats) != 1 || stats.Stats[0].Detail != "$42.00 left" {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}
