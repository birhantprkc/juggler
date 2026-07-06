//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/tests/helpers"
)

func TestConfig_Default(t *testing.T) {
	cfg := core.DefaultConfig()

	helpers.AssertEqual(t, cfg.Server.Port, 3939)
	helpers.AssertEqual(t, cfg.Server.Host, "localhost")
	helpers.AssertEqual(t, cfg.Context.TokenBudget, 0) // 0 = auto-calculate
	helpers.AssertTrue(t, len(cfg.Project.Exclude) > 0, "should have default excludes")
}

func TestConfig_LoadNonExistent(t *testing.T) {
	project := helpers.EmptyProject(t)
	defer project.Cleanup()

	cfg, err := core.LoadConfig(project.Path)
	helpers.AssertNoError(t, err)

	// Should return defaults
	helpers.AssertEqual(t, cfg.Server.Port, 3939)
}

func TestConfig_SaveAndLoad(t *testing.T) {
	project := helpers.EmptyProject(t)
	defer project.Cleanup()

	// Create custom config
	cfg := core.DefaultConfig()
	cfg.Model = "anthropic/claude-3-5-sonnet-20241022"
	cfg.Server.Port = 4000
	cfg.Context.TokenBudget = 10000

	// Save
	err := cfg.Save(project.Path)
	helpers.AssertNoError(t, err)

	// Load
	loaded, err := core.LoadConfig(project.Path)
	helpers.AssertNoError(t, err)

	helpers.AssertEqual(t, loaded.Model, "anthropic/claude-3-5-sonnet-20241022")
	helpers.AssertEqual(t, loaded.Server.Port, 4000)
	helpers.AssertEqual(t, loaded.Context.TokenBudget, 10000)
}

func TestConfig_GetModel(t *testing.T) {
	cfg := core.DefaultConfig()
	cfg.Model = "gemini/gemini-2.0-flash-exp"

	helpers.AssertEqual(t, cfg.GetModel(), "gemini/gemini-2.0-flash-exp")
}

func TestCalculateTokenBudget(t *testing.T) {
	tests := []struct {
		name           string
		explicitBudget int
		contextWindow  int
		expected       int
	}{
		{
			name:           "explicit budget takes precedence",
			explicitBudget: 5000,
			contextWindow:  200000,
			expected:       5000,
		},
		{
			name:           "auto-calculate 60% of context window",
			explicitBudget: 0,
			contextWindow:  200000,
			expected:       120000, // 60% of 200K
		},
		{
			name:           "auto-calculate for large context (Gemini)",
			explicitBudget: 0,
			contextWindow:  1000000,
			expected:       600000, // 60% of 1M
		},
		{
			name:           "return 0 if no context window",
			explicitBudget: 0,
			contextWindow:  0,
			expected:       0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := core.CalculateTokenBudget(tt.explicitBudget, tt.contextWindow)
			helpers.AssertEqual(t, result, tt.expected)
		})
	}
}
