//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"context"
	"fmt"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// usageEndpoint is the GLM Coding Plan quota endpoint. It lives at the API host
// root, not under the chat completions base path (.../api/coding/paas/v4), and
// is the same endpoint the official Z.ai coding plugins query. It is a var so
// tests can point it at an httptest server.
var usageEndpoint = "https://api.z.ai/api/monitor/usage/quota/limit"

const (
	fiveHourWindowSecs = 5 * 60 * 60
	weeklyWindowSecs   = 7 * 24 * 60 * 60
)

type usageResponse struct {
	Data   usageData    `json:"data"`
	Level  string       `json:"level"`  // fallback when the payload isn't wrapped in "data"
	Limits []usageLimit `json:"limits"` // fallback when the payload isn't wrapped in "data"
}

type usageData struct {
	Level  string       `json:"level"`
	Limits []usageLimit `json:"limits"`
}

type usageLimit struct {
	Type          string   `json:"type"`
	Unit          *int     `json:"unit"`          // time-unit code: 3 = hour, 6 = week
	Number        *int     `json:"number"`        // count of the unit defining the window
	Percentage    *float64 `json:"percentage"`    // 0..100
	NextResetTime *int64   `json:"nextResetTime"` // window reset, Unix milliseconds
}

// usageStats fetches GLM Coding Plan quota usage. The Z.ai quota endpoint
// authenticates with the raw API key in the Authorization header (no "Bearer"
// prefix), unlike the chat completions endpoint.
func usageStats(ctx context.Context, credential string, headers map[string]string) (provider.UsageStats, error) {
	var parsed usageResponse
	if err := utils.GetJSON(ctx, usageEndpoint, utils.JSONGetOptions{
		RawAuthorization: credential,
		Headers:          headers,
		Defaults: map[string]string{
			"Accept-Language": "en-US,en",
			"Content-Type":    "application/json",
		},
		Label: "Z.AI quota/limit",
	}, &parsed); err != nil {
		return provider.UsageStats{}, err
	}
	return buildUsageStats(parsed, time.Now()), nil
}

func buildUsageStats(parsed usageResponse, now time.Time) provider.UsageStats {
	limits := parsed.Data.Limits
	level := parsed.Data.Level
	if len(limits) == 0 {
		limits = parsed.Limits
	}
	if level == "" {
		level = parsed.Level
	}

	stats := provider.UsageStats{
		Provider:  "zai",
		Plan:      formatPlan(level),
		UpdatedAt: now,
	}
	for _, item := range limits {
		if item.Percentage == nil {
			continue
		}
		name, category, windowSecs := describeLimit(item)
		stat := provider.UsageStat{
			Name:        name,
			UsedPercent: provider.Pct(*item.Percentage),
			WindowSecs:  windowSecs,
			Category:    category,
		}
		if item.NextResetTime != nil && *item.NextResetTime > 0 {
			reset := time.UnixMilli(*item.NextResetTime).UTC()
			stat.ResetsAt = &reset
		}
		stats.Stats = append(stats.Stats, stat)
	}
	return stats
}

// describeLimit maps a Z.ai quota limit to a display name, UI category, and
// window duration. The 5-hour and weekly token windows share the TOKENS_LIMIT
// type and are told apart by unit/number (unit 3 = hour, unit 6 = week).
// Unrecognised shapes pass through with a distinct name so new limit kinds
// still surface rather than being silently merged or dropped.
func describeLimit(item usageLimit) (name, category string, windowSecs int) {
	switch item.Type {
	case "TOKENS_LIMIT":
		unit, number := intValue(item.Unit), intValue(item.Number)
		switch {
		case unit == 3 && number == 5:
			return "Session (5h)", "primary", fiveHourWindowSecs
		case unit == 6 && number == 1:
			return "Week (7d)", "weekly", weeklyWindowSecs
		case item.Unit != nil && item.Number != nil:
			return fmt.Sprintf("Tokens (unit=%d, number=%d)", unit, number), "model", 0
		default:
			return "Tokens", "model", 0
		}
	case "TIME_LIMIT":
		return "MCP (1 month)", "model", 0
	default:
		return humaniseLimitType(item.Type), "model", 0
	}
}

func intValue(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func formatPlan(level string) string {
	if level == "" {
		return ""
	}
	return strings.ToUpper(level[:1]) + strings.ToLower(level[1:])
}

func humaniseLimitType(limitType string) string {
	if limitType == "" {
		return "Usage"
	}
	words := strings.Fields(strings.ReplaceAll(strings.ToLower(limitType), "_", " "))
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}
