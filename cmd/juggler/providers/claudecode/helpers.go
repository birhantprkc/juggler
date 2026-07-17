//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Pure utilities used across the package: request-prefix hashing for
// cache-coherence checks, upstream-cache TTL constants, and the
// short-string formatters used in diagnostic logging. Anything that has
// state or non-trivial behaviour lives in its own file.
package claudecode

import (
	"fmt"
	"hash/fnv"
	"io"
	"sort"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// hashRequestPrefix produces a stable fingerprint of the request prefix —
// system prompt plus the first n messages — so we can cheaply detect
// whether a new request is a strict linear extension of what we previously
// fed to the CLI. Anything that affects the bytes the LLM sees goes into
// this hash: there is no privileged item in juggler (context items,
// messages, and system prompt are all just inputs), so an edit anywhere
// flips the hash and forces a fresh session.
func hashRequestPrefix(systemPrompt string, msgs []provider.Message, n int) uint64 {
	h := fnv.New64a()
	writeSystemPromptFields(h, systemPrompt)
	if n > len(msgs) {
		n = len(msgs)
	}
	for i := 0; i < n; i++ {
		writeMessageFields(h, &msgs[i])
	}
	return h.Sum64()
}

// writeSystemPromptFields / writeMessageFields are the single definition of the
// cache-relevant bytes of each request-prefix element. hashRequestPrefix folds
// them in order for the aggregate fingerprint; hashSystemPrompt and hashMessage
// hash one element in isolation. Sharing the writers keeps the per-element
// fingerprints byte-consistent with the aggregate, so any difference the
// aggregate detects is localisable element-by-element (see diagnoseDivergence).
func writeSystemPromptFields(w io.Writer, systemPrompt string) {
	_, _ = fmt.Fprintf(w, "sys\x01%s\x01", systemPrompt)
}

func writeMessageFields(w io.Writer, m *provider.Message) {
	_, _ = fmt.Fprintf(w, "%s\x00%s\x00%s\x00%s\x00%t\x00", m.Type, m.Content, m.ToolUseID, m.ToolName, m.IsError)
	// Attachments are identified by AssetID (the content hash), never by their
	// bytes — so an attachment edit flips the fingerprint and forces a fresh
	// session, while re-sending the same image keeps the prefix cache warm. The
	// rendered base64 is deliberately NOT hashed (that would needlessly
	// cold-start every image turn).
	for i := range m.Parts {
		p := &m.Parts[i]
		_, _ = fmt.Fprintf(w, "part\x02%s\x02%s\x02%s\x02", p.Type, p.Mime, p.AssetID)
	}
}

// hashSystemPrompt fingerprints only the system-prompt component of a request
// prefix, so a cache miss can be attributed to the system prompt (a context
// item or the env block rendering differently) rather than to a message.
func hashSystemPrompt(systemPrompt string) uint64 {
	h := fnv.New64a()
	writeSystemPromptFields(h, systemPrompt)
	return h.Sum64()
}

// hashMessage fingerprints a single message's cache-relevant fields.
func hashMessage(m *provider.Message) uint64 {
	h := fnv.New64a()
	writeMessageFields(h, m)
	return h.Sum64()
}

// hashMessages returns the per-message fingerprints of msgs[:n], used to
// localise which prefix message diverged.
func hashMessages(msgs []provider.Message, n int) []uint64 {
	if n > len(msgs) {
		n = len(msgs)
	}
	out := make([]uint64, n)
	for i := 0; i < n; i++ {
		out[i] = hashMessage(&msgs[i])
	}
	return out
}

// hashToolNames fingerprints the SET of tool names advertised to a CLI, order-
// independent. The claude CLI answers tools/list exactly once per spawn and
// freezes that snapshot for the process's whole lifetime, so a live CLI keeps
// exposing whatever tools existed at spawn time. When MCP servers finish
// discovery (or start/stop) mid-conversation, req.Tools changes but the live
// CLI's frozen list does not — the model can't see or call the new tools until
// the CLI is respawned. dispatchTurn compares this fingerprint against the live
// CLI's spawn-time signature and tears the CLI down (preserving the warm resume
// anchor) when they differ, so the respawn re-runs tools/list with the fresh
// set. Names are sorted first so a pure reordering of req.Tools does NOT force a
// needless respawn.
func hashToolNames(tools []provider.ToolDefinition) uint64 {
	names := make([]string, len(tools))
	for i := range tools {
		names[i] = tools[i].Name
	}
	sort.Strings(names)
	h := fnv.New64a()
	for _, n := range names {
		_, _ = fmt.Fprintf(h, "%s\x00", n)
	}
	return h.Sum64()
}

// upstreamCacheTTL is how long the upstream prompt cache (Anthropic's, when
// claude CLI talks to anthropic.com) is expected to stay warm with no
// activity. Used to flag stale-cache predictions; not load-bearing for
// correctness — a wrong guess just means the user sees an inaccurate
// estimate that the next real turn will correct.
const upstreamCacheTTL = 5 * time.Minute

// shortID truncates an identifier to its first 8 characters for log output;
// long IDs (UUIDs, conversation paths) bloat lines without adding signal.
func shortID(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:8]
}

// cacheHitRatio reports cacheRead / (cacheRead + input) as a 2-decimal string,
// or "n/a" when there is nothing to compare against. This is the single number
// that tells you whether the persistent-resume path is doing its job.
func cacheHitRatio(input, cacheRead int) string {
	denom := input + cacheRead
	if denom == 0 {
		return "n/a"
	}
	return fmt.Sprintf("%.2f", float64(cacheRead)/float64(denom))
}

// blockHistogram returns a compact "text=N thinking=N tool_use=N" tally over
// the turn's content blocks. Surfaced in the per-turn log so a silent turn
// (e.g. thinking-only or fully empty) is greppable rather than invisible.
func blockHistogram(blocks []provider.ContentBlock) string {
	counts := map[provider.ContentBlockType]int{}
	for i := range blocks {
		counts[blocks[i].Type]++
	}
	// Stable order regardless of which kinds appeared.
	order := []provider.ContentBlockType{
		provider.ContentBlockTypeText,
		provider.ContentBlockTypeThinking,
		provider.ContentBlockTypeToolUse,
	}
	var b strings.Builder
	for i, k := range order {
		if i > 0 {
			b.WriteByte(' ')
		}
		fmt.Fprintf(&b, "%s=%d", k, counts[k])
	}
	// Any other type that slipped through (e.g. status) gets a tail entry
	// so the histogram doesn't silently hide things.
	for k, n := range counts {
		known := false
		for _, ordered := range order {
			if k == ordered {
				known = true
				break
			}
		}
		if !known {
			fmt.Fprintf(&b, " %s=%d", k, n)
		}
	}
	return b.String()
}
