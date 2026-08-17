//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestEveryColdStartRoutesThroughTheWarning is the structural guard against
// silent token burn.
//
// A cold start re-ingests the whole conversation. When one happens deep in a
// warm path — a failed respawn, an unwritable stdin, an unserializable delta —
// the only trace used to be a [DEBUG] line, and the next turn's cache hit ratio
// reads ~99% because a small truncated context re-reads perfectly. So the spend
// climbs with no symptom anyone would notice.
//
// startFreshSession is therefore allowed exactly one caller: coldStartFallback,
// which logs the greppable "⚠ claudecode cache-miss" line and raises the UI
// warning. A new fallback that calls it directly is a new invisible re-ingest,
// and fails here.
func TestEveryColdStartRoutesThroughTheWarning(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob package sources: %v", err)
	}
	fset := token.NewFileSet()
	var offenders []string
	var callers int

	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			ast.Inspect(fn, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "startFreshSession" {
					return true
				}
				callers++
				if fn.Name.Name != "coldStartFallback" {
					offenders = append(offenders, fset.Position(call.Pos()).String()+" in "+fn.Name.Name)
				}
				return true
			})
		}
	}

	if callers == 0 {
		t.Fatal("found no startFreshSession callers — this guard has stopped guarding anything")
	}
	for _, o := range offenders {
		t.Errorf("%s calls startFreshSession directly: that cold start re-ingests the whole "+
			"conversation without logging ⚠ claudecode cache-miss or warning the user. "+
			"Route it through coldStartFallback with a reason instead.", o)
	}
}

// TestMidDispatchFallbackWarnsUser proves the wiring end to end for one real
// fallback: a warm resume whose CLI has died and cannot be respawned. The turn
// itself fails (the binary is gone), but the point is that the cold start
// announced itself on the way past rather than silently re-ingesting.
func TestMidDispatchFallbackWarnsUser(t *testing.T) {
	installFakeClaude(t, fakeModeUntilClose, "uuid-cold-visible")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-cold-visible"
	ctx := context.Background()

	// Big enough that emitCacheMissWarning considers the loss consequential.
	large := strings.Repeat("context ", 20_000)

	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg(large)},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}

	// The CLI dies and its binary is gone, so the warm resume can't respawn:
	// runPersistentResumeTurn must fall back to a cold start.
	c.activeSession.tearDownLiveCLI()
	restore := SetBinaryPathForTesting(filepath.Join(t.TempDir(), "claude-vanished"))
	defer restore()

	var statuses []provider.StreamChunk
	record := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeStatus {
			statuses = append(statuses, chunk)
		}
		return nil, nil
	}
	// The turn is expected to fail — there is no binary to run. We assert on
	// what the user was told on the way there.
	_, _ = c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg(large), assistantMsg(large), userMsg("carry on")},
	}, record)

	var reason string
	for _, s := range statuses {
		if r, ok := s.Metadata["cacheMissReason"].(string); ok {
			reason = r
		}
	}
	if reason == "" {
		t.Fatalf("no cache-miss warning reached the user for a mid-dispatch cold start; "+
			"status chunks seen: %+v", statuses)
	}
	if !strings.HasPrefix(reason, "resume-spawn-failed") {
		t.Errorf("cacheMissReason = %q; want it to name the failing step (resume-spawn-failed…) "+
			"so the log says which fallback burned the cache", reason)
	}
}
