//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Warm-append resume: deliver a parked tool_use's result by appending it into
// the CLI's OWN warm session file and re-resuming the same uuid, instead of
// cold-rebuilding the whole history under a fresh synthetic uuid.
//
// This is the warm path for a tool_result-bearing delta when the live CLI is
// gone — a user cancel that tore the parked CLI down then typed a new message,
// or the parked tool's answer arriving after a process restart. In both the
// resumed transcript ends on a dangling assistant tool_use the CLI would have
// answered over its (by-then-closed) control stream, so the result can NOT be
// piped on stdin (it has no open tools/call to bind to and is silently dropped —
// see deltaCarriesToolResult). Writing it into the session file is the only warm
// delivery: the unchanged prefix cache-hits and only the appended result plus
// the trailing user turn are fresh.

package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/anthropic"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/jlog"
)

// runWarmAppendResume dispatches regimeResumeAppendResult. It tears down any
// live/parked CLI (so the warm session file isn't held open), appends the
// delta's leading tool_results into that file to close the dangling tool_use,
// then --resumes the same warm uuid and pipes the non-tool_result tail (the
// user's interjected message; a continuation nudge if the delta was results
// only) on stdin.
//
// Every uncertainty falls back to a full fresh synthetic resume (today's
// behaviour) — so warm-append is strictly an optimisation and never worse than
// the cold path it replaces: a missing/unreadable warm file, a tail entry that
// isn't the expected dangling tool_use, or any spawn/stdin failure all degrade
// to startFreshSession.
func (c *Client) runWarmAppendResume(ctx context.Context, req provider.MessageRequest, deltaStart, deltaEnd int, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	tailStart, ok := pairedResultResumeSplit(req.Messages, deltaStart, deltaEnd)
	if !ok {
		// Classification and dispatch disagree — should be unreachable. Be safe.
		return c.coldStartFallback(ctx, req, callback, "warm-append-split-lost")
	}

	// We are about to mutate the warm session file and re-resume it, so no live
	// CLI may be holding it. Tear down any parked/live process first (no-op if
	// none); the resume anchor (uuid/sentCount/sentHash + sidecar) survives.
	c.activeSession.tearDownLiveCLI()
	c.activeSession.pendingTools = nil

	pairedResults := req.Messages[deltaStart:tailStart]
	if err := c.appendToolResultsToWarmSession(pairedResults); err != nil {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-failed: %v", err))
	}

	// Build the stdin tail: the non-tool_result delta (typically the user's
	// interjected message). When the delta was tool_results only (the parked
	// tool's answer with nothing newly typed), pipe the continuation nudge so
	// the model has a user turn to respond to — mirroring
	// moveTrailingToolResultsToHistory's empty-tail handling on the cold path.
	tail := req.Messages[tailStart:deltaEnd]
	stdinMsgs := tail
	if len(stdinMsgs) == 0 {
		stdinMsgs = []provider.Message{{Type: "user", Content: continuationNudge}}
	}
	lines, err := c.formatMessagesAsStreamJSONLines(stdinMsgs, c.activeSession.sessionUUID)
	if err != nil || len(lines) == 0 {
		return c.coldStartFallback(ctx, req, callback,
			fmt.Sprintf("warm-append-tail-unserializable: err=%v lines=%d", err, len(lines)))
	}
	payload := []byte(strings.Join(lines, "\n") + "\n")

	// Spinner feedback for the pre-first-token wait: the warm file is loaded by
	// a freshly-spawned --resume process, whose system/init flips the spinner.
	emitPhase(callback, phaseReconnecting)

	if err := c.ensurePersistentCLI(req); err != nil {
		return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-spawn-failed: %v", err))
	}
	if err := c.writeStdinDelta(payload); err != nil {
		// Stdin write failure ≈ process died between spawn and write. Recycle and
		// retry once, then fall back to fresh.
		jlog.Debug("warm-append: stdin write failed (%v) — respawning and retrying", err)
		c.activeSession.tearDownLiveCLI()
		if err := c.ensurePersistentCLI(req); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-respawn-failed: %v", err))
		}
		if err := c.writeStdinDelta(payload); err != nil {
			return c.coldStartFallback(ctx, req, callback, fmt.Sprintf("warm-append-stdin-failed: %v", err))
		}
	}
	c.recordConsumedRequest(req)

	jlog.Debug("=== CLAUDECODE WARM-APPEND RESUME (uuid=%s, %d paired result(s), %d tail msg(s)) ===",
		c.activeSession.sessionUUID, len(pairedResults), len(tail))

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// appendToolResultsToWarmSession appends a single `user: tool_result` entry —
// closing the warm transcript's dangling tool_use — to the CLI's own session
// file at ~/.claude/projects/<dir>/<sessionUUID>.jsonl, then atomically replaces
// it. The appended entry reuses the native session shape (newSyntheticEntry) and
// chains to the file's current last entry.
//
// It refuses (returns an error, so the caller cold-starts fresh) unless the file
// exists AND its last entry is the assistant tool_use the results answer — the
// guard that keeps the file's tool_use→tool_result adjacency valid even if the
// CLI happened to write a trailing non-tool entry.
func (c *Client) appendToolResultsToWarmSession(results []provider.Message) error {
	if c.activeSession == nil || c.activeSession.sessionUUID == "" {
		return fmt.Errorf("no warm session uuid to append to")
	}
	dir := projectsDir(c.workingDir)
	if dir == "" {
		return fmt.Errorf("no ~/.claude/projects dir for working dir %q", c.workingDir)
	}
	path := filepath.Join(dir, c.activeSession.sessionUUID+".jsonl")

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read warm session %s: %w", path, err)
	}
	trimmed := bytes.TrimRight(data, "\n")
	if len(trimmed) == 0 {
		return fmt.Errorf("warm session %s is empty", path)
	}
	lines := bytes.Split(trimmed, []byte("\n"))
	lastUUID, danglingIDs, err := parseTailToolUseEntry(lines[len(lines)-1])
	if err != nil {
		return fmt.Errorf("warm session %s: %w", path, err)
	}

	blocks := toolResultBlocks(results)
	if len(blocks) == 0 {
		return fmt.Errorf("no tool_result blocks to append")
	}
	for _, b := range blocks {
		if !danglingIDs[b.ToolUseID] {
			return fmt.Errorf("tool_result %s does not match the warm file's dangling tool_use", b.ToolUseID)
		}
	}

	entry := newSyntheticEntry("user", blocks, newSyntheticSessionUUID(), lastUUID,
		c.activeSession.sessionUUID, c.workingDir, time.Now())
	line, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("marshal append entry: %w", err)
	}

	out := make([]byte, 0, len(trimmed)+len(line)+2)
	out = append(out, trimmed...)
	out = append(out, '\n')
	out = append(out, line...)
	out = append(out, '\n')

	// Atomic replace so a torn write can never corrupt the warm session: write a
	// sibling temp then rename over the original (the CLI is dead, so no reader
	// races us).
	tmp := path + ".juggler-append.tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return fmt.Errorf("write temp session: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace warm session: %w", err)
	}
	return nil
}

// parseTailToolUseEntry decodes the warm file's last JSONL entry and returns its
// uuid (the parent for the appended result) plus the set of tool_use IDs it
// carries. Errors unless the entry is an assistant turn containing at least one
// tool_use — i.e. the file ends exactly where a dangling tool_use is expected.
func parseTailToolUseEntry(line []byte) (uuid string, toolUseIDs map[string]bool, err error) {
	var e struct {
		UUID    string `json:"uuid"`
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &e); err != nil {
		return "", nil, fmt.Errorf("unparseable last entry: %w", err)
	}
	if e.UUID == "" {
		return "", nil, fmt.Errorf("last entry has no uuid")
	}
	if e.Type != "assistant" {
		return "", nil, fmt.Errorf("last entry is %q, not an assistant tool_use", e.Type)
	}
	ids := map[string]bool{}
	for _, b := range e.Message.Content {
		if b.Type == "tool_use" && b.ID != "" {
			ids[b.ID] = true
		}
	}
	if len(ids) == 0 {
		return "", nil, fmt.Errorf("last entry carries no tool_use to close")
	}
	return e.UUID, ids, nil
}

// toolResultBlocks converts the delta's paired tool-result messages into
// Anthropic tool_result content blocks for the appended session entry.
func toolResultBlocks(results []provider.Message) []anthropic.APIContentBlock {
	var blocks []anthropic.APIContentBlock
	for _, m := range results {
		if m.Type != "tool-result" {
			continue
		}
		blocks = append(blocks, anthropic.APIContentBlock{
			Type:      "tool_result",
			ToolUseID: m.ToolUseID,
			Content:   m.Content,
			IsError:   m.IsError,
		})
	}
	return blocks
}
