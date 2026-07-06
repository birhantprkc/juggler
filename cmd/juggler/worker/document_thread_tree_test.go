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
