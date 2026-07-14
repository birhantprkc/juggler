//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"fmt"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// OpenRouter exposes a money balance, not a rate-limit window. /credits gives
// the account's purchased-vs-spent totals; /auth/key is the per-key fallback
// (and the only one reachable when /credits is gated to a management key). Both
// are vars so tests can point them at an httptest server.
var (
	creditsURL = baseURL + "/credits"
	keyURL     = baseURL + "/auth/key"
)

type creditsResponse struct {
	Data creditsData `json:"data"`
}

type creditsData struct {
	TotalCredits float64 `json:"total_credits"`
	TotalUsage   float64 `json:"total_usage"`
}

type keyResponse struct {
	Data keyData `json:"data"`
}

type keyData struct {
	Usage          float64  `json:"usage"`
	Limit          *float64 `json:"limit"`
	LimitRemaining *float64 `json:"limit_remaining"`
	IsFreeTier     bool     `json:"is_free_tier"`
}

// usageStats reports the OpenRouter credit balance. It prefers /credits (account
// totals) and falls back to /auth/key (per-key usage/limit) when /credits is
// unavailable — e.g. when that endpoint requires a management key.
func usageStats(ctx context.Context, credential string, headers map[string]string) (provider.UsageStats, error) {
	var credits creditsResponse
	if err := utils.GetJSON(ctx, creditsURL, utils.JSONGetOptions{
		Bearer:   credential,
		Headers:  headers,
		Defaults: map[string]string{"Accept": "application/json"},
		Label:    "OpenRouter /credits",
	}, &credits); err == nil {
		return buildFromCredits(credits.Data, time.Now()), nil
	} else {
		creditsErr := err
		var key keyResponse
		if kerr := utils.GetJSON(ctx, keyURL, utils.JSONGetOptions{
			Bearer:   credential,
			Headers:  headers,
			Defaults: map[string]string{"Accept": "application/json"},
			Label:    "OpenRouter /auth/key",
		}, &key); kerr != nil {
			return provider.UsageStats{}, fmt.Errorf("OpenRouter usage unavailable (credits: %v; auth/key: %w)", creditsErr, kerr)
		}
		return buildFromKey(key.Data, time.Now()), nil
	}
}

func buildFromCredits(data creditsData, now time.Time) provider.UsageStats {
	stats := provider.UsageStats{Provider: "openrouter", UpdatedAt: now}
	stat := provider.UsageStat{Name: "Credits", Category: "balance"}
	if data.TotalCredits > 0 {
		remaining := data.TotalCredits - data.TotalUsage
		stat.Detail = fmt.Sprintf("%s of %s left", usd(remaining), usd(data.TotalCredits))
		stat.UsedPercent = provider.Pct(clampPercent(data.TotalUsage / data.TotalCredits * 100))
	} else {
		// Pay-as-you-go with no purchased credit pool: only cumulative spend is meaningful.
		stat.Name = "Usage"
		stat.Detail = usd(data.TotalUsage) + " used"
	}
	stats.Stats = append(stats.Stats, stat)
	return stats
}

func buildFromKey(data keyData, now time.Time) provider.UsageStats {
	stats := provider.UsageStats{Provider: "openrouter", UpdatedAt: now}
	if data.IsFreeTier {
		stats.Plan = "Free"
	}
	stat := provider.UsageStat{Name: "Credits", Category: "balance"}
	if data.Limit != nil && *data.Limit > 0 {
		remaining := *data.Limit - data.Usage
		if data.LimitRemaining != nil {
			remaining = *data.LimitRemaining
		}
		stat.Detail = fmt.Sprintf("%s of %s left", usd(remaining), usd(*data.Limit))
		stat.UsedPercent = provider.Pct(clampPercent(data.Usage / *data.Limit * 100))
	} else {
		stat.Name = "Usage"
		stat.Detail = usd(data.Usage) + " used"
	}
	stats.Stats = append(stats.Stats, stat)
	return stats
}

func usd(v float64) string { return fmt.Sprintf("$%.2f", v) }

func clampPercent(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
