//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// usageEndpoint is the DeepSeek prepaid-balance endpoint. It sits at the API
// host root, not under the chat completions /v1 base path. It is a var so tests
// can point it at an httptest server.
var usageEndpoint = "https://api.deepseek.com/user/balance"

type balanceResponse struct {
	IsAvailable  bool          `json:"is_available"`
	BalanceInfos []balanceInfo `json:"balance_infos"`
}

type balanceInfo struct {
	Currency     string `json:"currency"`      // "USD" or "CNY"
	TotalBalance string `json:"total_balance"` // decimal string, e.g. "110.00"
}

// usageStats fetches the DeepSeek prepaid account balance. DeepSeek exposes a
// remaining balance rather than a rate-limit window, so each stat is a raw money
// value (no percentage meter).
func usageStats(ctx context.Context, credential string, headers map[string]string) (provider.UsageStats, error) {
	var parsed balanceResponse
	if err := utils.GetJSON(ctx, usageEndpoint, utils.JSONGetOptions{
		Bearer:   credential,
		Headers:  headers,
		Defaults: map[string]string{"Accept": "application/json"},
		Label:    "DeepSeek /user/balance",
	}, &parsed); err != nil {
		return provider.UsageStats{}, err
	}
	return buildUsageStats(parsed, time.Now()), nil
}

func buildUsageStats(parsed balanceResponse, now time.Time) provider.UsageStats {
	stats := provider.UsageStats{
		Provider:  "deepseek",
		UpdatedAt: now,
	}
	multiCurrency := len(parsed.BalanceInfos) > 1
	for _, info := range parsed.BalanceInfos {
		amount, err := strconv.ParseFloat(info.TotalBalance, 64)
		if err != nil {
			continue
		}
		name := "Balance"
		if multiCurrency {
			name = "Balance (" + info.Currency + ")"
		}
		stats.Stats = append(stats.Stats, provider.UsageStat{
			Name:     name,
			Detail:   formatMoney(info.Currency, amount) + " left",
			Category: "balance",
		})
	}
	return stats
}

// formatMoney renders an amount with the currency's symbol where known, falling
// back to a trailing currency code for anything unrecognised.
func formatMoney(currency string, amount float64) string {
	switch currency {
	case "USD":
		return fmt.Sprintf("$%.2f", amount)
	case "CNY":
		return fmt.Sprintf("¥%.2f", amount)
	default:
		return fmt.Sprintf("%.2f %s", amount, currency)
	}
}
