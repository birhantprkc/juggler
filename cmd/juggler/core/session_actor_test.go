//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"sync"
	"testing"
)

// These tests pin the SessionManager actor's central safety contract: the live
// session never escapes the actor goroutine. GetSession hands out an isolated
// clone, and every mutation runs inside the actor (Update / PatchMetadata).
//
// The contract exists because handlers mutating a shared live *Session map
// from concurrent request goroutines trip the runtime's always-on "concurrent
// map writes" detector — fatal, killing the whole server under load. With the
// live session reachable only through the actor, that shape is not
// expressible.

// GetSession must return an isolated snapshot: mutating it (poking the
// map/slices from a request goroutine) leaves the stored session untouched.
func TestGetSessionSnapshotIsolation(t *testing.T) {
	m := newManagerForTest(t)
	if _, err := m.PatchMetadata(map[string]any{"k": "v"}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	snap := m.GetSession()
	snap.Metadata["k"] = "mutated"
	snap.Metadata["new"] = "x"
	snap.ConversationOrder = append(snap.ConversationOrder, "ghost")
	snap.MessageHistory = append(snap.MessageHistory, "ghost")

	got := m.GetSession()
	if got.Metadata["k"] != "v" {
		t.Fatalf("snapshot mutation leaked into stored metadata: %+v", got.Metadata)
	}
	if _, ok := got.Metadata["new"]; ok {
		t.Fatalf("added key leaked into stored session: %+v", got.Metadata)
	}
	if len(got.ConversationOrder) != 0 {
		t.Fatalf("ConversationOrder mutation leaked: %+v", got.ConversationOrder)
	}
	if len(got.MessageHistory) != 0 {
		t.Fatalf("MessageHistory mutation leaked: %+v", got.MessageHistory)
	}
}

func TestPatchMetadataBasic(t *testing.T) {
	m := newManagerForTest(t)

	changed, err := m.PatchMetadata(map[string]any{"theme": "dark", "count": float64(3)})
	if err != nil {
		t.Fatalf("PatchMetadata: %v", err)
	}
	if changed["theme"] != "dark" || changed["count"] != float64(3) {
		t.Fatalf("changed set wrong: %+v", changed)
	}

	// nil value deletes; other keys survive the patch.
	if _, err := m.PatchMetadata(map[string]any{"theme": nil, "extra": true}); err != nil {
		t.Fatalf("PatchMetadata delete: %v", err)
	}
	got := m.GetSession().Metadata
	if _, ok := got["theme"]; ok {
		t.Fatalf("theme should have been deleted, got %+v", got)
	}
	if got["count"] != float64(3) || got["extra"] != true {
		t.Fatalf("surviving/added keys wrong: %+v", got)
	}
}

// TestSessionConcurrentReadWrite hammers writers (PatchMetadata) and readers
// (GetSession + map iteration) at once — the load shape that stresses the
// actor. Writers serialise through the actor; readers walk their own clones, so
// no memory is shared. It runs clean under -race: a shared-pointer design would
// report a data race here (and could fatal on a concurrent map op).
func TestSessionConcurrentReadWrite(t *testing.T) {
	m := newManagerForTest(t)

	const writers = 32
	const perWriter = 20

	var wg sync.WaitGroup
	wg.Add(writers)
	for w := 0; w < writers; w++ {
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				key := fmt.Sprintf("k_%d_%d", w, i)
				if _, err := m.PatchMetadata(map[string]any{key: w*1000 + i}); err != nil {
					t.Errorf("PatchMetadata: %v", err)
					return
				}
			}
		}(w)
	}

	// Readers race the writers, iterating their private snapshots' maps.
	const readers = 8
	wg.Add(readers)
	for r := 0; r < readers; r++ {
		go func() {
			defer wg.Done()
			for i := 0; i < writers*perWriter; i++ {
				for range m.GetSession().Metadata { //nolint:revive
				}
			}
		}()
	}

	wg.Wait()

	got := m.GetSession().Metadata
	if len(got) != writers*perWriter {
		t.Fatalf("expected %d keys, got %d", writers*perWriter, len(got))
	}
	for w := 0; w < writers; w++ {
		for i := 0; i < perWriter; i++ {
			key := fmt.Sprintf("k_%d_%d", w, i)
			if got[key] != w*1000+i {
				t.Fatalf("key %s = %v, want %d", key, got[key], w*1000+i)
			}
		}
	}
}
