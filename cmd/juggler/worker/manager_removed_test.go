//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "testing"

// TestRemovedConvDoesNotReloadAWorker pins the window that outlived a bin. The
// bin handler removes the worker and only then moves the folder, so between
// those two steps the path provider still resolves the id — and a client message
// arriving in that window recreated a worker for a conversation that was about
// to stop existing. That worker loaded the doc and ran turns normally while
// every save was dropped as unowned, and its tab lived on with nothing behind it.
//
// The path provider here always resolves, which is exactly the state of that
// window: refusal has to come from the manager knowing the id was removed.
func TestRemovedConvDoesNotReloadAWorker(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	m.SetPathProvider(func(string) (string, bool) { return t.TempDir(), true })

	m.GetOrCreate("conv-binned", "user:test")
	m.Remove("conv-binned")

	if handled := m.HandleMessageWithClient("conv-binned", "client-A", "ping", nil, func([]byte) {}); handled {
		t.Fatal("a late client message recreated a worker for a removed conversation")
	}
	if w := m.Get("conv-binned"); w != nil {
		t.Fatal("removed conversation has a worker again")
	}
}

// TestConversationRestoredReadmitsConv: the block Remove places is lifted when
// the conversation comes back out of the bin, or a restored tab would open onto
// a worker that is never created.
func TestConversationRestoredReadmitsConv(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	m.SetPathProvider(func(string) (string, bool) { return t.TempDir(), true })

	m.GetOrCreate("conv-restored", "user:test")
	m.Remove("conv-restored")
	m.ConversationRestored("conv-restored")

	if handled := m.HandleMessageWithClient("conv-restored", "client-A", "ping", nil, func([]byte) {}); !handled {
		t.Fatal("restored conversation still refuses to load a worker")
	}
}
