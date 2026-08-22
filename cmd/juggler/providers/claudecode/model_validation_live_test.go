//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// TestModelAliasesAreAccepted_Live verifies that every model id juggler
// advertises in ListModelsWithInfo is actually accepted by the installed
// claude CLI — i.e. we didn't typo an alias or keep one Anthropic has retired.
//
// This is the ONLY way to check the hardcoded names against reality: the CLI
// has no offline "list models" command, so we ask it directly. A bad name
// comes back as `error":"model_not_found"` with HTTP 404 (the same signal
// parser.go surfaces at runtime); a good one runs a trivial turn.
//
// Opt-in only — it spawns the real CLI, which needs OAuth/network and spends a
// few tokens. Skipped unless JUGGLER_CLAUDECODE_LIVE=1 and a claude binary is
// present, so it never runs in `make test`. Run it by hand after touching the
// alias list:
//
//	JUGGLER_CLAUDECODE_LIVE=1 go test -v -count=1 \
//	  -run TestModelAliasesAreAccepted_Live ./cmd/juggler/providers/claudecode
func TestModelAliasesAreAccepted_Live(t *testing.T) {
	if os.Getenv("JUGGLER_CLAUDECODE_LIVE") != "1" {
		t.Skip("set JUGGLER_CLAUDECODE_LIVE=1 to run the live model-name check (spawns the real claude CLI)")
	}
	if claudeBinaryPath == "" {
		t.Skip("claude CLI not found on PATH or known install locations")
	}

	c, err := NewClient(provider.Config{Model: "sonnet"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	infos, err := c.ListModelsWithInfo(context.Background())
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}
	if len(infos) == 0 {
		t.Fatal("ListModelsWithInfo returned no models")
	}

	for _, mi := range infos {
		mi := mi
		t.Run(mi.ID, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			// Same --model arg juggler sends; a tiny prompt keeps cost minimal.
			cmd := exec.CommandContext(ctx, claudeBinaryPath,
				"--model", mi.ID,
				"-p", "reply with the single word ok",
				"--output-format", "stream-json", "--verbose")
			out, _ := cmd.CombinedOutput() // a rejected model exits non-zero; we assert on content
			if bytes.Contains(out, []byte("model_not_found")) ||
				bytes.Contains(out, []byte("issue with the selected model")) {
				t.Errorf("claude CLI rejected model %q — fix the alias in ListModelsWithInfo / modelAlias.\nCLI output:\n%s", mi.ID, out)
			}
		})
	}
}
