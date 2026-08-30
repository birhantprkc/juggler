//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██ ██   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestOneShotRunSeedsServiceTier pins the user-visible contract that broke once
// already: a default model saved with a serving tier ("Fast") must reach the
// turn itself, not just the settings screen. The transaction blob's modelConfig
// is the only on-disk record of what the turn actually ran with, so it is what
// this reads — a seed that dropped the tier would show the right model name
// everywhere in the UI while every turn quietly ran on standard serving.
//
// Same harness as TestOneShotRunWritesAFileUnattended: shipped binary, stand-in
// OpenAI-compatible gateway, isolated config dir holding the tiered default.
func TestOneShotRunSeedsServiceTier(t *testing.T) {
	binary := oneShotBinary(t)

	proj := t.TempDir()
	gateway := startFakeGateway(t, filepath.Join(proj, "unused.txt"))
	cfgDir := writeOneShotConfig(t, gateway.URL+"/v1")
	// Overwrite the default-model.json the harness wrote with a tiered one: the
	// openai-compatible provider ignores serviceTier on the wire, which is fine —
	// the question is only whether the seed preserves it.
	tiered := map[string]string{
		"provider":    "openai-compatible",
		"model":       oneShotModelID,
		"serviceTier": "priority",
	}
	data, err := json.Marshal(tiered)
	if err != nil {
		t.Fatalf("marshal tiered default: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "default-model.json"), data, 0o600); err != nil {
		t.Fatalf("write tiered default-model.json: %v", err)
	}

	stdout, stderr, code := runOneShot(t, binary, proj, cfgDir, 3*time.Minute,
		"Say potato.")
	report := func(format string, args ...any) string {
		return formatAndTail(format, args, stderr)
	}
	if code != 0 {
		t.Fatal(report("`juggler run` exited %d, want 0.\nstdout:\n%s", code, stdout))
	}

	outcome := decodeOnlyJSONObject(t, stdout, stderr)
	if outcome.ConversationDir == "" {
		t.Fatal(report("the outcome named no conversation directory"))
	}
	convDir := outcome.ConversationDir
	if !filepath.IsAbs(convDir) {
		convDir = filepath.Join(proj, convDir)
	}

	// Read every blob and require the tier on each modelConfig found.
	entries, err := os.ReadDir(filepath.Join(convDir, "txns"))
	if err != nil {
		t.Fatal(report("no transaction blobs to inspect: %v", err))
	}
	blobs := 0
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(convDir, "txns", e.Name()))
		if err != nil {
			t.Fatal(report("read blob %s: %v", e.Name(), err))
		}
		var blob struct {
			ModelConfig map[string]string `json:"modelConfig"`
		}
		if err := json.Unmarshal(raw, &blob); err != nil {
			t.Fatal(report("parse blob %s: %v", e.Name(), err))
		}
		blobs++
		if blob.ModelConfig["serviceTier"] != "priority" {
			t.Errorf("blob %s modelConfig = %v — the serving tier was dropped from the seeded default",
				e.Name(), blob.ModelConfig)
		}
	}
	if blobs == 0 {
		t.Fatal(report("no transaction blobs were written, so the turn never ran"))
	}
	t.Logf("%d transaction blobs carried serviceTier=priority", blobs)
}

// formatAndTail keeps the report helper local without redefining the one-shot
// file's closure pattern.
func formatAndTail(format string, args []any, stderr string) string {
	return fmt.Sprintf(format, args...) + "\n" + tailLog(stderr)
}
