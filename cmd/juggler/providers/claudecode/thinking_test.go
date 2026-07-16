//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"slices"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestMaxThinkingTokensForLevel pins the canonical level → MAX_THINKING_TOKENS
// budget mapping, and that off/absent/unknown omit the var.
func TestMaxThinkingTokensForLevel(t *testing.T) {
	on := map[string]int{
		provider.ThinkingLow:    2048,
		provider.ThinkingMedium: 8192,
		provider.ThinkingHigh:   16384,
		provider.ThinkingMax:    32768,
	}
	for level, want := range on {
		got, ok := maxThinkingTokensForLevel(level)
		if !ok || got != want {
			t.Errorf("level %q: got (%d,%v), want (%d,true)", level, got, ok, want)
		}
	}
	for _, level := range []string{"", provider.ThinkingOff, "garbage"} {
		if _, ok := maxThinkingTokensForLevel(level); ok {
			t.Errorf("level %q: expected no budget (var omitted)", level)
		}
	}
}

// TestThinkingSpawnExtras proves a leveled turn injects MAX_THINKING_TOKENS and
// records the spawned level, while off/absent turns omit the var.
func TestThinkingSpawnExtras(t *testing.T) {
	c := &Client{thinkingLevel: provider.ThinkingHigh}
	extras := c.thinkingSpawnExtras()
	if !slices.Contains(extras, "MAX_THINKING_TOKENS=16384") {
		t.Errorf("high turn extras = %v, want MAX_THINKING_TOKENS=16384", extras)
	}
	if c.spawnedThinkingLevel != provider.ThinkingHigh {
		t.Errorf("spawnedThinkingLevel = %q, want high", c.spawnedThinkingLevel)
	}

	c2 := &Client{thinkingLevel: provider.ThinkingOff}
	for _, e := range c2.thinkingSpawnExtras() {
		if len(e) >= len("MAX_THINKING_TOKENS") && e[:len("MAX_THINKING_TOKENS")] == "MAX_THINKING_TOKENS" {
			t.Errorf("off turn must omit MAX_THINKING_TOKENS, got %q", e)
		}
	}
	if c2.spawnedThinkingLevel != provider.ThinkingOff {
		t.Errorf("spawnedThinkingLevel = %q, want off", c2.spawnedThinkingLevel)
	}
}
