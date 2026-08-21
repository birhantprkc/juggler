//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// insertThreadReturningID inserts a root-level thread with the given goal and
// returns its generated itemId plus the nested items Y.Array.
func insertThreadReturningID(t *testing.T, w *ConversationWorker, goal string) string {
	t.Helper()
	w.doc.InsertThread(w.doc.GetItemsLength(), goal)
	var id string
	ycrdtMu.Lock()
	walkThreads(w.doc.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		if g, _ := m.Get("goal").(string); g == goal {
			id, _ = m.Get("itemId").(string)
			return true
		}
		return false
	})
	ycrdtMu.Unlock()
	if id == "" {
		t.Fatalf("could not resolve itemId for thread %q", goal)
	}
	return id
}

// TestResolveModelConfigDefaultKey pins the Issue-1 rename: the conversation-level
// DEFAULT model lives under the `defaultModelConfig` metadata key (the thread-level
// override key stays `modelConfig`). The root resolves to the default key.
func TestResolveModelConfigDefaultKey(t *testing.T) {
	w := NewConversationWorker("conv-mc-default", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-A", "model": "model-A"})

	got := w.doc.ResolveEffectiveModelConfig("")
	if got == nil || got.Provider != "prov-A" || got.Model != "model-A" {
		t.Fatalf("root must resolve the defaultModelConfig metadata key, got %+v", got)
	}
}

// TestResolveModelConfigCarriesBothDials proves the two per-model dials survive
// resolution together, at the conversation default and at a thread override.
// They ride inside one modelConfig object, so a decoder that learned about one
// and not the other would silently drop the other — and dropping the serving
// tier means quietly reverting a choice the user pays extra for.
func TestResolveModelConfigCarriesBothDials(t *testing.T) {
	w := NewConversationWorker("conv-mc-dials", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.doc.SetMetadata("defaultModelConfig", map[string]any{
		"provider": "openaicodex", "model": "gpt-5.6-luna",
		"thinking": "high", "serviceTier": "priority",
	})

	got := w.doc.ResolveEffectiveModelConfig("")
	if got == nil || got.Thinking != "high" || got.ServiceTier != "priority" {
		t.Fatalf("conversation default lost a dial: %+v", got)
	}

	threadID := insertThreadReturningID(t, w, "sub thread")
	w.doc.SetThreadField(threadID, "modelConfig", map[string]any{
		"provider": "openaicodex", "model": "gpt-5.6-sol",
		"thinking": "xhigh", "serviceTier": "priority",
	})

	sub := w.doc.ResolveEffectiveModelConfig(threadID)
	if sub == nil || sub.Model != "gpt-5.6-sol" || sub.Thinking != "xhigh" || sub.ServiceTier != "priority" {
		t.Fatalf("thread override lost a dial: %+v", sub)
	}

	// Standard serving is the absence of the key, not an empty-string tier —
	// a config written before the field existed must resolve to standard.
	w.doc.SetMetadata("defaultModelConfig", map[string]any{
		"provider": "openaicodex", "model": "gpt-5.6-luna", "thinking": "high",
	})
	if got := w.doc.ResolveEffectiveModelConfig(""); got == nil || got.ServiceTier != "" {
		t.Fatalf("absent serviceTier must resolve to standard serving, got %+v", got)
	}
}

// TestResolveModelConfigLegacyMetadataKeyFallback pins the compatibility fallback:
// a pre-rename session stored its conversation default under the legacy
// `modelConfig` METADATA key (not `defaultModelConfig`). Resolution must fall back
// to it so such a session isn't stuck on "please select a model" despite holding a
// real persisted default.
func TestResolveModelConfigLegacyMetadataKeyFallback(t *testing.T) {
	w := NewConversationWorker("conv-mc-legacy", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	// Only the legacy key is present — no defaultModelConfig.
	w.doc.SetMetadata("modelConfig", map[string]any{"provider": "prov-legacy", "model": "model-legacy", "thinking": "high"})

	got := w.doc.ResolveEffectiveModelConfig("")
	if got == nil || got.Provider != "prov-legacy" || got.Model != "model-legacy" || got.Thinking != "high" {
		t.Fatalf("root must fall back to the legacy modelConfig metadata key, got %+v", got)
	}
}

// TestResolveModelConfigDefaultKeyWinsOverLegacy confirms the new
// `defaultModelConfig` key takes precedence when both keys are present, so the
// legacy fallback never shadows a current default.
func TestResolveModelConfigDefaultKeyWinsOverLegacy(t *testing.T) {
	w := NewConversationWorker("conv-mc-legacy-precedence", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-new", "model": "model-new"})
	w.doc.SetMetadata("modelConfig", map[string]any{"provider": "prov-legacy", "model": "model-legacy"})

	got := w.doc.ResolveEffectiveModelConfig("")
	if got == nil || got.Provider != "prov-new" || got.Model != "model-new" {
		t.Fatalf("defaultModelConfig must win over the legacy key, got %+v", got)
	}
}

// TestResolveModelConfigThreadOverrideWinsOverDefault confirms a sub-thread's own
// `modelConfig` override wins over the conversation default, while the root still
// resolves the default — the canonical inheritance property after the rename.
func TestResolveModelConfigThreadOverrideWinsOverDefault(t *testing.T) {
	w := NewConversationWorker("conv-mc-override", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-A", "model": "model-A"})
	threadID := insertThreadReturningID(t, w, "sub thread")
	w.doc.SetThreadField(threadID, "modelConfig", map[string]any{"provider": "prov-B", "model": "model-B"})

	sub := w.doc.ResolveEffectiveModelConfig(threadID)
	if sub == nil || sub.Provider != "prov-B" || sub.Model != "model-B" {
		t.Fatalf("sub-thread override must win, got %+v", sub)
	}
	root := w.doc.ResolveEffectiveModelConfig("")
	if root == nil || root.Provider != "prov-A" || root.Model != "model-A" {
		t.Fatalf("root must resolve the conversation default, got %+v", root)
	}
}

// TestResolveModelConfigThinkingDefaultKey confirms the optional thinking level
// rides through the conversation-default resolution alongside the model.
func TestResolveModelConfigThinkingDefaultKey(t *testing.T) {
	w := NewConversationWorker("conv-mc-thinking-default", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-A", "model": "model-A", "thinking": "high"})

	got := w.doc.ResolveEffectiveModelConfig("")
	if got == nil || got.Thinking != "high" {
		t.Fatalf("default thinking must resolve, got %+v", got)
	}
}

// TestResolveModelConfigThinkingOverrideWins confirms a sub-thread's own
// modelConfig thinking wins, and that a thread override WITHOUT thinking yields
// empty thinking rather than inheriting the parent's — thinking rides atomically
// with the (provider, model) override, it never cross-inherits separately.
func TestResolveModelConfigThinkingOverrideWins(t *testing.T) {
	w := NewConversationWorker("conv-mc-thinking-override", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-A", "model": "model-A", "thinking": "high"})

	// Thread with its own thinking wins.
	t1 := insertThreadReturningID(t, w, "thread-own-thinking")
	w.doc.SetThreadField(t1, "modelConfig", map[string]any{"provider": "prov-B", "model": "model-B", "thinking": "low"})
	if got := w.doc.ResolveEffectiveModelConfig(t1); got == nil || got.Thinking != "low" {
		t.Fatalf("thread override thinking must win, got %+v", got)
	}

	// Thread override WITHOUT thinking → empty, not the default's "high".
	t2 := insertThreadReturningID(t, w, "thread-no-thinking")
	w.doc.SetThreadField(t2, "modelConfig", map[string]any{"provider": "prov-C", "model": "model-C"})
	if got := w.doc.ResolveEffectiveModelConfig(t2); got == nil || got.Thinking != "" {
		t.Fatalf("override without thinking must not inherit default thinking, got %+v", got)
	}
}
