//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"context"
	"os"
	"sort"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestModelMetadataCoversCatalog_Live checks our local capability maps against
// the live z.ai catalog. The model LIST is already API-driven — ListModelsWithInfo
// pulls it from /models, so new GLM releases appear with no code change. What
// this guards is the metadata that endpoint can't supply (its objects carry
// only id/object/created/owned_by — no window, no output cap):
//
//   - every advertised model must resolve to a sane window and output cap, so a
//     regression in the caps wiring fails loudly rather than silently mis-sizing;
//   - override keys z.ai no longer serves are surfaced as prunable dead entries.
//
// This is as far as automation can go: the API doesn't return the numbers, so
// they can't be auto-derived — only drift-detected. Opt-in only; it spends a
// network round-trip against your real key and is skipped in `make test`. Run
// it by hand after a z.ai model release:
//
//	JUGGLER_ZAI_LIVE=1 ZAI_API_KEY=... go test -v -count=1 \
//	  -run TestModelMetadataCoversCatalog_Live ./cmd/juggler/providers/zai
func TestModelMetadataCoversCatalog_Live(t *testing.T) {
	if os.Getenv("JUGGLER_ZAI_LIVE") != "1" {
		t.Skip("set JUGGLER_ZAI_LIVE=1 (and ZAI_API_KEY) to run the live catalog drift check")
	}
	key := os.Getenv("ZAI_API_KEY")
	if key == "" {
		t.Skip("ZAI_API_KEY not set")
	}

	Register()
	p, err := provider.InitializeProvider("zai", provider.Config{APIKey: key, Model: "glm-4.6"})
	if err != nil {
		t.Fatalf("InitializeProvider: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	infos, err := p.ListModelsWithInfo(ctx)
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	if len(infos) == 0 {
		t.Fatal("z.ai returned no models")
	}

	live := make(map[string]bool, len(infos))
	for _, mi := range infos {
		live[mi.ID] = true
		t.Logf("live model %-16s window=%-7d maxOut=%d", mi.ID, mi.ContextWindow, mi.MaxOutputTokens)
		// The numbers the API can't give us must still be sane for every model
		// it advertises. Bounds track the documented catalog floor and the
		// coding-plan output ceiling (~98K).
		if mi.ContextWindow < 128000 {
			t.Errorf("model %q: context window %d below the 128000 catalog floor — add an override in models.go", mi.ID, mi.ContextWindow)
		}
		if mi.MaxOutputTokens < 16384 || mi.MaxOutputTokens > 98304 {
			t.Errorf("model %q: max output %d outside [16384, 98304] plan ceiling", mi.ID, mi.MaxOutputTokens)
		}
	}

	// Override keys z.ai no longer serves. Not fatal — a model can be absent for
	// one plan/key yet valid generally — but surfaced so the map can be pruned.
	var dead []string
	for id := range ModelContextWindows {
		if !live[id] {
			dead = append(dead, id)
		}
	}
	sort.Strings(dead)
	for _, id := range dead {
		t.Logf("NOTE: ModelContextWindows pins %q but the live catalog omits it — consider pruning", id)
	}
}
