//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, usageEndpoint, nil)
	if err != nil {
		return provider.UsageStats{}, fmt.Errorf("failed to build Z.AI usage request: %w", err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if credential != "" {
		req.Header.Set("Authorization", credential)
	}
	if req.Header.Get("Accept-Language") == "" {
		req.Header.Set("Accept-Language", "en-US,en")
	}
	if req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return provider.UsageStats{}, fmt.Errorf("failed to fetch Z.AI usage: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return provider.UsageStats{}, fmt.Errorf("Z.AI quota/limit returned %d: %s", resp.StatusCode, string(body))
	}

	var parsed usageResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return provider.UsageStats{}, fmt.Errorf("failed to decode Z.AI usage response: %w", err)
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
