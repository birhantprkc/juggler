//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"slices"
	"strings"
	"testing"
)

// TestClaudecodeEffortLevels pins the advertised set to the claude CLI's native
// effort vocabulary (low/medium/high/xhigh/max — verbatim from the CLI), and
// that the advertised list and the accepted set are the same source of truth so
// they cannot drift.
func TestClaudecodeEffortLevels(t *testing.T) {
	want := []string{"low", "medium", "high", "xhigh", "max"}
	for _, family := range []string{"opus", "sonnet", "haiku", "fable"} {
		if got := thinkingLevelsFor(family); !slices.Equal(got, want) {
			t.Errorf("thinkingLevelsFor(%q) = %v, want %v", family, got, want)
		}
	}
	// Every advertised level is accepted; nothing outside the set is.
	for _, lvl := range want {
		if !effortLevelSupported(lvl) {
			t.Errorf("advertised level %q must be accepted by effortLevelSupported", lvl)
		}
	}
	for _, lvl := range []string{"", "off", "minimal", "none", "garbage"} {
		if effortLevelSupported(lvl) {
			t.Errorf("effortLevelSupported(%q) = true, want false", lvl)
		}
	}
}

// TestThinkingSpawnExtras proves a leveled turn injects CLAUDE_CODE_EFFORT_LEVEL
// with the level passed through verbatim (including xhigh, the tier that has no
// token-budget equivalent), records the spawned level, and that off/absent turns
// omit the var so the CLI keeps its default adaptive thinking.
func TestThinkingSpawnExtras(t *testing.T) {
	for _, level := range []string{"high", "xhigh", "max"} {
		c := &Client{thinkingLevel: level}
		extras := c.thinkingSpawnExtras()
		if !slices.Contains(extras, "CLAUDE_CODE_EFFORT_LEVEL="+level) {
			t.Errorf("%s turn extras = %v, want CLAUDE_CODE_EFFORT_LEVEL=%s", level, extras, level)
		}
		if c.spawnedThinkingLevel != level {
			t.Errorf("spawnedThinkingLevel = %q, want %q", c.spawnedThinkingLevel, level)
		}
	}

	for _, level := range []string{"", "off", "garbage"} {
		c := &Client{thinkingLevel: level}
		for _, e := range c.thinkingSpawnExtras() {
			if strings.HasPrefix(e, "CLAUDE_CODE_EFFORT_LEVEL=") {
				t.Errorf("level %q must omit CLAUDE_CODE_EFFORT_LEVEL, got %q", level, e)
			}
		}
		if c.spawnedThinkingLevel != level {
			t.Errorf("spawnedThinkingLevel = %q, want %q", c.spawnedThinkingLevel, level)
		}
	}
}
