//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Per-regime dispatch functions invoked from StreamMessage, plus the
// shared finalizeTurn bookkeeping that every regime ends in. The regime
// decision itself lives in regime.go; the stream-parser state machine in
// parser.go.

package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/jlog"
)

// Phase labels surfaced on the UI spinner during the otherwise-silent window
// between starting a turn and the model's first streamed token. Cold starts
// spend that window spawning the CLI, loading a synthetic-resume session, and
// running the MCP handshake — minutes, sometimes — with nothing else to show.
const (
	phaseStarting          = "Starting Claude Code"
	phaseReconnecting      = "Reconnecting Claude Code"
	phaseProcessingHistory = "Processing conversation history"
	phaseWaiting           = "Waiting for response"
	phaseGenerating        = "Generating response"
)

// emitPhase forwards a transient liveness/phase label to the UI spinner as a
// status chunk. This is the cold-start feedback path: before the first token
// nothing else streams, so without these the spinner sits on a static
// "Receiving..." for the whole wait and looks jammed. Best-effort — a dropped
// label (e.g. a cancelled callback) never affects turn correctness, and status
// chunks are not counted as streamed content so they never block a retry.
func emitPhase(callback provider.StructuredStreamCallback, msg string) {
	if callback == nil {
		return
	}
	_, _ = callback(provider.StreamChunk{Type: provider.ContentBlockTypeStatus, Content: msg})
}

// startFreshSession spawns a new CLI invocation in streaming-input mode
// (`--input-format stream-json`). We always use streaming input — never
// `-p <inline-JSON>` — because the stdio control protocol requires the
// CLI to be reading stdin.
//
// When the conversation has prior turns, we synthesise a JSONL session
// file (see synthetic_resume.go) and spawn with `--resume <uuid>` so the
// CLI loads the assistant history as its own. Without this the stream-json
// parser silently drops assistant blocks and Claude is trained to reject
// fed assistant content as injected — leaving the model amnesiac about
// its own prior tool_use calls. With no prior history we just spawn fresh
// and let the CLI mint a session_id we'll capture from system/init.
func (c *Client) startFreshSession(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("════════════════════════════════════════════════════════════════")
	jlog.Debug("=== CLAUDECODE FRESH SESSION (--input-format stream-json) ===")

	// Cold start: the CLI must spawn and load the (synthetic) session before
	// it emits anything. Surface that immediately so the spinner reflects the
	// real phase; the parser flips it to phaseWaiting on system/init.
	emitPhase(callback, phaseStarting)

	args := []string{"-p", "--input-format", "stream-json"}
	args = append(args, c.commonArgs(req.SystemPrompt)...)

	plan := planSyntheticSession(req.Messages, jugglerToolNameSet(req.Tools))
	if plan != nil {
		// Cold start carrying prior history: the slow segment is the API
		// re-ingesting the whole conversation (a guaranteed cache miss). Label
		// the post-boot wait so it reads as expensive-but-working rather than
		// jammed. A true first turn (plan == nil) keeps the generic phaseWaiting.
		c.turnWaitingPhase = phaseProcessingHistory
		path, err := writeSyntheticSession(c.workingDir, plan)
		if err != nil {
			jlog.Debug("synthetic resume: write failed (%v) — falling back to history-less cold start", err)
			plan = nil
			c.turnWaitingPhase = phaseWaiting
		} else {
			jlog.Debug("synthetic resume: wrote %s (%d entries) — spawning with --resume %s",
				path, len(plan.historyToFile), plan.sessionUUID)
			args = append(args, "--resume", plan.sessionUUID)
		}
	}

	if err := c.spawnCLIPipes(args); err != nil {
		return nil, err
	}

	// Wire the stdio control protocol so the CLI can call back into our
	// in-process MCP server for tool execution.
	if err := c.attachControlProtocol(req.Tools); err != nil {
		return nil, fmt.Errorf("attach control protocol: %w", err)
	}

	if plan != nil {
		// Synthetic-resume path: file holds the history, only the tail user
		// turn goes on stdin.
		if err := c.writeStdinDelta(append(tailStdinLine(plan), '\n')); err != nil {
			return nil, fmt.Errorf("write fresh-session tail message: %w", err)
		}
	} else {
		// No prior history (or fallback): pipe whatever user-role messages
		// the worker built. Assistant turns are still dropped here, but
		// without history there are none to drop.
		lines, err := c.formatMessagesAsStreamJSONLines(req.Messages, "")
		if err != nil {
			return nil, fmt.Errorf("format stream-json messages: %w", err)
		}
		if len(lines) == 0 {
			return nil, fmt.Errorf("no user-role messages to send in fresh session")
		}
		if err := c.writeStdinDelta([]byte(strings.Join(lines, "\n") + "\n")); err != nil {
			return nil, fmt.Errorf("write fresh-session user messages: %w", err)
		}
	}

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// attachControlProtocol constructs a controlProtocol bound to the active
// session's stdin and wires it to deliver the given tool list on
// tools/list. Fires the SDK→CLI initialize handshake. Caller is
// responsible for the session's existing setup; this only attaches the
// control layer.
func (c *Client) attachControlProtocol(tools []provider.ToolDefinition) error {
	if c.activeSession == nil || c.activeSession.live == nil || c.activeSession.live.stdin == nil {
		return fmt.Errorf("control protocol: no stdin on active session")
	}
	cp := newControlProtocol(c.activeSession.live.stdin)
	// Marshal tools once; cp.tools is invoked each time the CLI sends
	// tools/list. The list is stable per-session so we memoise.
	marshalled, err := toolDefsToMCPList(tools)
	if err != nil {
		return fmt.Errorf("marshal tools: %w", err)
	}
	cp.tools = func() ([]json.RawMessage, error) { return marshalled, nil }
	c.activeSession.live.control = cp
	// Record the tool-set fingerprint this CLI is being spawned with. The CLI
	// answers tools/list once and freezes it, so dispatchTurn compares a later
	// turn's req.Tools against this to decide whether a respawn is needed to
	// surface newly-discovered (or removed) MCP tools. See hashToolNames.
	c.activeSession.live.toolSig = hashToolNames(tools)
	// Launch the continuous stdout reader now that the control protocol is
	// attached: it demuxes control frames to the actor and forwards content
	// to s.content. Started before sendInitialize so the CLI's initialize
	// control_response is routed by the reader rather than lost.
	startStreamReader(c.activeSession)
	return cp.sendInitialize()
}

// runPersistentResumeTurn handles a juggler turn against a persistent
// `claude --resume <uuid> --input-format stream-json` process. If no live CLI
// is attached to the session, it spawns one. Delta messages are written to
// the still-open stdin; we never close stdin or the process at end_turn.
//
// On stdin write failure (process died between turns), we kill, respawn once,
// and retry. If that also fails, we drop the session and fall through to a
// fresh -p invocation.
func (c *Client) runPersistentResumeTurn(ctx context.Context, req provider.MessageRequest, deltaStart, deltaEnd int, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	delta := req.Messages[deltaStart:deltaEnd]
	deltaLines, err := c.formatMessagesAsStreamJSONLines(delta, c.activeSession.sessionUUID)
	if err != nil || len(deltaLines) == 0 {
		jlog.Debug("Delta empty or unserializable (err=%v, lines=%d) — falling back to fresh", err, len(deltaLines))
		c.dispatchFreshStart()
		return c.startFreshSession(ctx, req, callback)
	}

	stdinPayload := []byte(strings.Join(deltaLines, "\n") + "\n")

	// Spinner feedback for the pre-first-token wait. A live CLI goes straight
	// to waiting on the model; a cold session must respawn first (and the
	// respawn's system/init will itself flip the spinner to phaseWaiting).
	if c.activeSession.hasLiveCLI() {
		emitPhase(callback, phaseWaiting)
	} else {
		emitPhase(callback, phaseReconnecting)
	}

	// Ensure the persistent CLI is alive. ensurePersistentCLI is a no-op if it
	// already is.
	if err := c.ensurePersistentCLI(req); err != nil {
		jlog.Debug("ensurePersistentCLI failed (%v) — falling back to fresh", err)
		c.dispatchFreshStart()
		return c.startFreshSession(ctx, req, callback)
	}

	if err := c.writeStdinDelta(stdinPayload); err != nil {
		// Stdin write failure ≈ process is dead. Recycle and retry once.
		jlog.Debug("stdin write failed (%v) — respawning persistent CLI and retrying", err)
		c.activeSession.tearDownLiveCLI()
		if err := c.ensurePersistentCLI(req); err != nil {
			c.dispatchFreshStart()
			return c.startFreshSession(ctx, req, callback)
		}
		if err := c.writeStdinDelta(stdinPayload); err != nil {
			jlog.Debug("retry stdin write also failed (%v) — fresh start", err)
			c.dispatchFreshStart()
			return c.startFreshSession(ctx, req, callback)
		}
	}

	jlog.Debug("=== CLAUDECODE RESUME TURN (uuid=%s, %d delta lines) ===",
		c.activeSession.sessionUUID, len(deltaLines))

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// runResumeNudge pipes a synthetic user message (continuationNudge) into the
// live --resume session when the worker has nothing new to send (typically:
// previous turn returned only thinking, or the user clicked Continue with no
// edits). The nudge is intentionally NOT added to req.Messages so the
// worker-side sentCount / sentHash bookkeeping stays aligned with what the
// worker thinks the conversation contains; the CLI's own --resume history
// silently absorbs the extra round-trip on its end. Cache stays warm.
//
// Falls back to a fresh start on any spawn/stdin failure — same shape as
// runPersistentResumeTurn's error handling.
func (c *Client) runResumeNudge(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	nudge := []provider.Message{{Type: "user", Content: continuationNudge}}
	nudgeLines, err := c.formatMessagesAsStreamJSONLines(nudge, c.activeSession.sessionUUID)
	if err != nil || len(nudgeLines) == 0 {
		jlog.Debug("nudge serialise failed (err=%v) — falling back to fresh", err)
		c.dispatchFreshStart()
		return c.startFreshSession(ctx, req, callback)
	}
	payload := []byte(strings.Join(nudgeLines, "\n") + "\n")

	// Spinner feedback for the pre-first-token wait (see runPersistentResumeTurn).
	if c.activeSession.hasLiveCLI() {
		emitPhase(callback, phaseWaiting)
	} else {
		emitPhase(callback, phaseReconnecting)
	}

	if err := c.ensurePersistentCLI(req); err != nil {
		c.dispatchFreshStart()
		return c.startFreshSession(ctx, req, callback)
	}
	if err := c.writeStdinDelta(payload); err != nil {
		c.activeSession.tearDownLiveCLI()
		if err := c.ensurePersistentCLI(req); err != nil {
			c.dispatchFreshStart()
			return c.startFreshSession(ctx, req, callback)
		}
		if err := c.writeStdinDelta(payload); err != nil {
			c.dispatchFreshStart()
			return c.startFreshSession(ctx, req, callback)
		}
	}

	jlog.Debug("=== CLAUDECODE NUDGE TURN (uuid=%s) === (no-new-msgs; piped continuationNudge)",
		c.activeSession.sessionUUID)

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// continueSession feeds tool results to the existing live CLI and continues
// reading the same LLM turn. No new CLI is spawned. Threading the full
// MessageRequest through (rather than just ConversationID + Messages) is
// load-bearing for resume bookkeeping: finalizeTurn captures the system
// prompt in the prefix hash on success, so the next turn won't be flagged as
// diverged when the prompt is unchanged.
func (c *Client) continueSession(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	jlog.Debug("=== CLAUDECODE CONTINUE SESSION (mid-turn tool result feed) ===")

	if c.activeSession.live == nil || c.activeSession.live.control == nil {
		return nil, fmt.Errorf("continueSession: no control protocol attached")
	}

	toolResults := c.extractToolResults(req.Messages)
	jlog.Debug("Feeding %d tool results via stdio control protocol", len(toolResults))
	for _, result := range toolResults {
		// The worker feeds results in pendingTools order, and the CLI parks
		// tools/call in that same order, so each result answers the FRONT of
		// the control protocol's unanswered queue. We still resolve the meta to
		// (a) discard a result whose id isn't in this turn's pendingTools and
		// (b) supply the recorded key for the divergence diagnostic.
		var meta pendingToolMeta
		for i := range c.activeSession.pendingTools {
			if c.activeSession.pendingTools[i].ID == result.ToolUseID {
				meta = c.activeSession.pendingTools[i]
				break
			}
		}
		if meta.ID == "" {
			jlog.Debug("No pending-tool meta for %s; result will be discarded", result.ToolUseID)
			continue
		}
		// Idempotent delivery backstop: each tool_use_id is answered exactly once, so
		// a second feed of an already-fed id is a duplicate re-feed — dropped, loudly,
		// before it can become a stash orphan. With the resultFedTurn cure in place no
		// re-feed reaches here in a reachable flow; see doc.go's "Tool-delivery desync".
		if c.activeSession.fedResultIDs[result.ToolUseID] {
			jlog.Error("claudecode: refusing to re-feed tool result for %s (already delivered this turn) — worker/engine re-emitted a duplicate result; dropping to prevent a stash orphan (delivery-desync genesis)", result.ToolUseID)
			continue
		}
		if _, err := c.activeSession.live.control.deliverNextToolResult(makeMCPMatchKey(meta.Name, meta.Args), result); err != nil {
			return nil, fmt.Errorf("deliver tool-result for %s: %w", result.ToolUseID, err)
		}
		if c.activeSession.fedResultIDs == nil {
			c.activeSession.fedResultIDs = make(map[string]bool)
		}
		c.activeSession.fedResultIDs[result.ToolUseID] = true
	}

	// Tool results are fed; the model now resumes the paused turn. Surface the
	// wait so the spinner isn't a static "Receiving..." while it thinks.
	emitPhase(callback, phaseWaiting)

	turn, _, err := c.readUntilPauseOrComplete(ctx, callback)
	return c.finalizeTurn(req, turn, err)
}

// extractToolResults extracts tool results from messages for sending to MCP.
// Results are returned in pendingTools order, which matches the order the
// CLI will issue tools/call requests. Message-array order can differ (e.g.
// the user approved Tool B before Tool A), which would pair wrong results
// with wrong tool calls if we iterated by message position instead.
func (c *Client) extractToolResults(messages []provider.Message) []*provider.ToolResult {
	resultByID := make(map[string]*provider.ToolResult)
	for _, msg := range messages {
		if msg.Type == "tool-result" {
			status := provider.ResultStatusSuccess
			if msg.IsError {
				status = provider.ResultStatusError
			}
			resultByID[msg.ToolUseID] = &provider.ToolResult{
				ToolUseID:    msg.ToolUseID,
				Content:      msg.Content,
				ResultStatus: status,
			}
		}
	}

	var results []*provider.ToolResult
	for _, t := range c.activeSession.pendingTools {
		if r, ok := resultByID[t.ID]; ok {
			results = append(results, r)
		}
	}
	return results
}

// captureSentPrefix records the fingerprints of the STABLE (systemPrompt,
// messages) prefix the CLI now holds. sentCount/sentHash drive the next turn's
// canResumeWithDelta delta detection; sentSystemHash/sentMsgHashes are the
// per-element fingerprints diagnoseDivergence uses to localise a cache miss.
//
// The anchor deliberately covers only stablePrefixCount(messages) — it excludes
// the trailing run of volatile standing-context messages the worker appends
// each turn. Those re-render live and get displaced as the conversation grows,
// so anchoring on len(messages) would flag every turn as "diverged" and
// cold-start the whole history (the cache-busting regression this repairs). The
// CLI still physically holds the context tail we fed it; we simply don't let it
// participate in the resume decision, so the current context rides in each
// turn's delta while the committed history resumes warm.
func (s *activeSession) captureSentPrefix(systemPrompt string, messages []provider.Message) {
	stable := stablePrefixCount(messages)
	s.sentCount = stable
	s.sentHash = hashRequestPrefix(systemPrompt, messages, stable)
	s.sentSystemHash = hashSystemPrompt(systemPrompt)
	s.sentMsgHashes = hashMessages(messages, stable)
}

// finalizeTurn handles bookkeeping common to fresh and resume turns: error
// cleanup, session-uuid capture, sentCount/sentHash update on success, and
// sidecar persistence.
//
// Provider-boundary normalisation: the claude CLI reports input_tokens as
// the *fresh-only* portion of the prompt (everything that wasn't a cache
// hit or cache write). For the rest of juggler — UI cache display,
// transaction blob accounting, cost-tracking — we want the consistent
// "total prompt tokens sent" semantic that openai/gemini providers
// already produce. So we sum fresh + cache_read + cache_creation here
// and report that as StreamResult.InputTokens. CachedTokens stays the
// cache-read subset; CacheWriteTokens stays the cache-creation subset.
func (c *Client) finalizeTurn(req provider.MessageRequest, turn *turnResult, err error) (*provider.StreamResult, error) {
	if err != nil {
		// Turn-execution failure (stream stall on sleep/wake, rate-limit
		// exhaustion, API 400/529, cancel). The error only reaches here after
		// the CLI was successfully spawned/resumed and the input written —
		// the genuinely-unresumable cases (resume/spawn/stdin failure) fall
		// back to startFreshSession upstream and never get here. So the
		// upstream session is still intact on disk, sitting at the last good
		// end_turn the sidecar already points at: tear down the live CLI and
		// drop the in-memory session, but KEEP the sidecar so the user's
		// retry --resumes warm instead of cold-starting the whole history.
		// Surface whatever usage we managed to collect before the failure.
		var inTok, outTok, cacheR, cacheW int
		if turn != nil {
			inTok, outTok = turn.InputTokens+turn.CacheReadTokens+turn.CacheWriteTokens, turn.OutputTokens
			cacheR, cacheW = turn.CacheReadTokens, turn.CacheWriteTokens
		}
		// releaseSession's contract (kill the live CLI, KEEP the sidecar so a
		// retry --resumes warm), inlined so we can read the reaped process's
		// exit status in between and enrich an unexpected-exit error with it
		// before the in-memory handle is dropped.
		c.activeSession.tearDownLiveCLI()
		if c.activeSession != nil {
			err = annotateExit(err, c.activeSession.exitDiag)
			// A user cancel interrupts mid-stream after we'd already fed the
			// new user message to the CLI (advancing its on-disk transcript)
			// but before end_turn could advance the anchor. Advance it now to
			// the committed prefix so the next turn resumes with only the
			// genuinely-new tail, and a rollback past this point trips
			// canResumeWithDelta's shrunk/diverged check into a clean fresh
			// start (the reported "responds to my deleted message" bug). A
			// non-cancel error (stall/rate-limit) leaves the anchor alone: the
			// user retries the SAME request, which must re-feed the same delta.
			if errors.Is(err, context.Canceled) {
				c.activeSession.captureSentPrefix(req.SystemPrompt, req.Messages)
				if c.activeSession.sessionUUID != "" {
					c.saveSidecar(req.ConversationID, c.activeSession)
				}
			}
		}
		c.activeSession = nil
		return &provider.StreamResult{
			StopReason:       "error",
			InputTokens:      inTok,
			OutputTokens:     outTok,
			CachedTokens:     cacheR,
			CacheWriteTokens: cacheW,
		}, err
	}

	// Capture session_id learned from the stream so future turns can --resume.
	if turn.SessionID != "" && c.activeSession.sessionUUID == "" {
		c.activeSession.sessionUUID = turn.SessionID
	}
	// Refresh lastUsedAt so the sweeper sees recent activity even on
	// freshly-spawned sessions that hadn't been touched at StreamMessage entry.
	c.activeSession.lastUsedAt = time.Now()

	if turn.StopReason == "tool_use" {
		// Mid-LLM-turn pause. We must NOT report the fresh input or cache-READ
		// here: the same warm prefix is re-read by every chained API call in the
		// turn and shows up again at end_turn, so counting it per pause would
		// inflate the turn's totals 10-40× (the 8754k-vs-200k-window blow-up).
		//
		// Cache-CREATION is the exception, and reporting it is what keeps a
		// cache regression visible. The API bills each prompt segment's cache
		// write exactly once across the whole turn — a later call reads it
		// (cache_read), never re-writes it — so summing cache_creation across
		// every tool_use pause and the final end_turn reconstructs the real
		// ingested size with no double-count. Surfacing it means a cold-start
		// re-ingest (huge cache_creation) lands in the per-conversation
		// [turn tokens] line as input>0 / 0% hit instead of a benign all-zero
		// row that hides the burn; a genuinely warm pause writes ~nothing and
		// stays quiet. Fresh input and cache-read stay zero for the reasons
		// above; the representative prompt size is still emitted at end_turn.
		var pending []pendingToolMeta
		for _, block := range turn.Blocks {
			if block.Type != provider.ContentBlockTypeToolUse {
				continue
			}
			// Canonicalize args by marshaling block.ToolInput (a Go map);
			// Go's json.Marshal sorts map keys recursively, giving the
			// MCP router a stable key for matching against the CLI's
			// tools/call payload (which goes through the same Marshal path).
			argsJSON, err := json.Marshal(block.ToolInput)
			if err != nil {
				argsJSON = []byte("{}")
			}
			pending = append(pending, pendingToolMeta{
				ID:   block.ToolUseID,
				Name: block.ToolName,
				Args: argsJSON,
			})
		}
		if len(pending) == 0 {
			// Defensive: tool_use stop with no ids — bail and start fresh next time.
			c.dropSession(req.ConversationID)
			return &provider.StreamResult{StopReason: turn.StopReason}, nil
		}
		c.activeSession.pendingTools = pending
		// Stash the snapshot for diagnostic logging only — never returned.
		c.activeSession.inputTokens = turn.InputTokens
		c.activeSession.outputTokens = turn.OutputTokens
		c.activeSession.cacheReadTokens = turn.CacheReadTokens
		c.activeSession.cacheWriteTokens = turn.CacheWriteTokens
		// Advance the resume anchor to the prefix the CLI has now durably
		// committed: it consumed every fed user message through req.Messages
		// and emitted its tool_use. Capturing here (not only at end_turn)
		// keeps the anchor honest while the turn is parked, so a cancel,
		// interjection, or reopen resumes with a delta of just the tail
		// (tool_results + any new message) instead of re-feeding the
		// already-committed user turn — and a rollback past this point trips
		// canResumeWithDelta's shrunk/diverged check into a clean fresh start.
		c.activeSession.captureSentPrefix(req.SystemPrompt, req.Messages)
		c.activeSession.model = c.model
		c.activeSession.lastCacheRead = turn.CacheReadTokens
		c.activeSession.lastTurnAt = time.Now()
		if c.activeSession.sessionUUID != "" {
			c.saveSidecar(req.ConversationID, c.activeSession)
		}
		// The CLI is now blocked on stdin waiting for our control_response
		// for each pending tools/call. Stdio has no transport timeout, so
		// the CLI patiently waits for as long as the user takes to
		// approve. No watchdog needed. Per-conv state lives on
		// c.activeSession (set in-place above) — no broadcast needed.
		jlog.Debug("Session paused: %d pending tool IDs (uuid=%s, partial in=%d out=%d cacheWrite=%d)",
			len(pending), c.activeSession.sessionUUID, turn.InputTokens, turn.OutputTokens, turn.CacheWriteTokens)
		// Report only the fresh cache-creation of this parked call (see the long
		// note above): non-double-counted, and it keeps a cold-start re-ingest
		// visible in the [turn tokens] line instead of an all-zero row.
		return &provider.StreamResult{
			StopReason:       turn.StopReason,
			InputTokens:      turn.CacheWriteTokens,
			CacheWriteTokens: turn.CacheWriteTokens,
		}, nil
	}

	// End of LLM turn. The CLI's stream events report CUMULATIVE usage for
	// the whole API call (input set once at message_start, output growing
	// monotonically), so turn.InputTokens etc. already hold the final
	// authoritative numbers. Normalise input to "total prompt tokens
	// sent" (fresh + cache read + cache write) for the rest of juggler;
	// keep `fresh` separate for the diagnostic hit-ratio log.
	stopReason := turn.StopReason
	fresh := turn.InputTokens
	cacheR := turn.CacheReadTokens
	cacheW := turn.CacheWriteTokens
	in := fresh + cacheR + cacheW
	out := turn.OutputTokens

	// Stream-json mode: CLI keeps idling on stdin for the next turn. Just
	// clear the per-turn scratch fields; the process, stdin, and scanner
	// channels stay alive.
	c.activeSession.pendingTools = nil
	c.activeSession.fedResultIDs = nil
	// The LLM turn is fully resolved, so anything still in the control
	// protocol's pairing buffers is an orphan from a tool desync this turn.
	// Clear it here (alongside pendingTools) so one desync can't poison the
	// rest of the warm session by leaving a stale result for a later same-tool
	// call to drain via the name fallback — see discardStaleBuffers.
	if c.activeSession.live != nil && c.activeSession.live.control != nil {
		if s, p := c.activeSession.live.control.discardStaleBuffers(); s > 0 || p > 0 {
			jlog.Error("claudecode turn boundary: discarded %d orphaned stashed result(s) + %d orphaned parked call(s) — a tool desync occurred this turn (results may have been mispaired); blast radius bounded to this turn (uuid=%s)",
				s, p, c.activeSession.sessionUUID)
		}
	}
	c.activeSession.inputTokens = 0
	c.activeSession.outputTokens = 0
	c.activeSession.cacheReadTokens = 0
	c.activeSession.cacheWriteTokens = 0
	c.activeSession.captureSentPrefix(req.SystemPrompt, req.Messages)
	c.activeSession.model = c.model
	c.activeSession.lastCacheRead = cacheR
	c.activeSession.lastTurnAt = time.Now()

	if c.activeSession.sessionUUID != "" {
		c.saveSidecar(req.ConversationID, c.activeSession)
		jlog.Debug("claudecode turn: conv=%s in=%d fresh=%d out=%d cacheRead=%d cacheWrite=%d hitRatio=%s msgsInReq=%d sentCount=%d uuid=%s blocks=%s stop=%s",
			shortID(req.ConversationID), in, fresh, out, cacheR, cacheW,
			cacheHitRatio(fresh, cacheR), len(req.Messages), c.activeSession.sentCount,
			shortID(c.activeSession.sessionUUID), blockHistogram(turn.Blocks), stopReason)
	} else {
		// No UUID captured — can't resume, drop entirely.
		jlog.Debug("No session_id captured from stream; dropping session")
		c.deleteSidecar(req.ConversationID)
		c.activeSession = nil
	}

	return &provider.StreamResult{
		StopReason:       stopReason,
		InputTokens:      in,
		OutputTokens:     out,
		CachedTokens:     cacheR,
		CacheWriteTokens: cacheW,
	}, nil
}
