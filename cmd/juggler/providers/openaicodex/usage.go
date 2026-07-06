//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

type usageResponse struct {
	PlanType            string                `json:"plan_type"`
	RateLimit           usageRateLimit        `json:"rate_limit"`
	AdditionalRateLimit []additionalRateLimit `json:"additional_rate_limits"`
	CodeReviewRateLimit usageRateLimit        `json:"code_review_rate_limit"`
}

type additionalRateLimit struct {
	LimitName string         `json:"limit_name"`
	RateLimit usageRateLimit `json:"rate_limit"`
}

type usageRateLimit struct {
	PrimaryWindow   usageWindow `json:"primary_window"`
	SecondaryWindow usageWindow `json:"secondary_window"`
}

type usageWindow struct {
	UsedPercent        *float64 `json:"used_percent"`
	ResetAt            int64    `json:"reset_at"`
	LimitWindowSeconds int      `json:"limit_window_seconds"`
}

func usageStats(ctx context.Context, bearerToken string, headers map[string]string) (provider.UsageStats, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/usage", nil)
	if err != nil {
		return provider.UsageStats{}, fmt.Errorf("failed to build OpenAI Codex usage request: %w", err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	if req.Header.Get("User-Agent") == "" {
		// The ChatGPT backend serves an HTML 403 challenge to Go's default
		// User-Agent on /usage, while the Codex CLI/browser-like clients receive
		// JSON. Keep this endpoint probe browser-shaped.
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")
	}

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return provider.UsageStats{}, fmt.Errorf("failed to fetch OpenAI Codex usage: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return provider.UsageStats{}, fmt.Errorf("OpenAI Codex /usage returned %d: %s", resp.StatusCode, string(body))
	}

	var parsed usageResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return provider.UsageStats{}, fmt.Errorf("failed to decode OpenAI Codex usage response: %w", err)
	}
	return buildUsageStats(parsed, time.Now()), nil
}

func buildUsageStats(parsed usageResponse, now time.Time) provider.UsageStats {
	stats := provider.UsageStats{
		Provider:  "openaicodex",
		Plan:      parsed.PlanType,
		UpdatedAt: now,
	}
	addWindow := func(name, category string, w usageWindow) {
		if w.UsedPercent == nil {
			return
		}
		stat := provider.UsageStat{
			Name:        name,
			UsedPercent: provider.Pct(*w.UsedPercent),
			WindowSecs:  w.LimitWindowSeconds,
			Category:    category,
		}
		if w.ResetAt > 0 {
			reset := time.Unix(w.ResetAt, 0).UTC()
			stat.ResetsAt = &reset
		}
		stats.Stats = append(stats.Stats, stat)
	}

	addWindow("Session (5h)", "primary", parsed.RateLimit.PrimaryWindow)
	addWindow("Week (7d)", "weekly", parsed.RateLimit.SecondaryWindow)
	for _, item := range parsed.AdditionalRateLimit {
		if item.LimitName == "" {
			continue
		}
		addWindow(item.LimitName+" (5h)", "model", item.RateLimit.PrimaryWindow)
		addWindow(item.LimitName+" (7d)", "model", item.RateLimit.SecondaryWindow)
	}
	addWindow("Code Review", "code_review", parsed.CodeReviewRateLimit.PrimaryWindow)
	return stats
}
