//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"testing"
	"time"
)

// newTestAppState builds just enough appState to exercise the registry: the ops
// channel and the goroutine that owns regState. It deliberately skips
// newAppState, which resolves GPU policy and loads the persisted workspace —
// filesystem work the handshake has nothing to do with.
func newTestAppState(t *testing.T) *appState {
	t.Helper()
	a := &appState{regOps: make(chan func(*regState), 32)}
	st := &regState{windows: map[string]*winEntry{}}
	go func() {
		for op := range a.regOps {
			op(st)
		}
	}()
	t.Cleanup(func() { close(a.regOps) })
	return a
}

// registerTestWindow adds a bare entry the handshake can be armed against.
func registerTestWindow(a *appState, id string) *winEntry {
	e := &winEntry{id: id}
	a.reg(func(st *regState) { st.windows[id] = e })
	return e
}

// closed reports whether ch has been closed, without blocking.
func closed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestFlushHandshakeReleasesOnMatchingToken(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	token, done := a.armFlushWait(e)
	if token == "" {
		t.Fatal("armFlushWait returned an empty token")
	}
	if closed(done) {
		t.Fatal("handshake was already complete before the page replied")
	}

	a.releaseFlushWait(e, token)
	if !closed(done) {
		t.Fatal("a reply quoting the announced token must release the waiter")
	}
}

func TestFlushHandshakeIgnoresWrongToken(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	_, done := a.armFlushWait(e)

	a.releaseFlushWait(e, "not-the-token")
	if closed(done) {
		t.Fatal("a reply with the wrong token must not release the waiter")
	}
	a.releaseFlushWait(e, "")
	if closed(done) {
		t.Fatal("an empty token must not release the waiter")
	}
}

// A quit and an updater restart both announce a close, so a reply to the first
// announcement must not satisfy the second — that would hand back an instant
// "drafts are safe" for a flush that never ran.
func TestFlushHandshakeIgnoresStaleTokenAfterReArming(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	stale, first := a.armFlushWait(e)
	fresh, second := a.armFlushWait(e)
	if stale == fresh {
		t.Fatal("re-arming must mint a new token, or a stale reply satisfies the new wait")
	}

	a.releaseFlushWait(e, stale)
	if closed(second) {
		t.Fatal("a reply to the previous announcement must not release the current one")
	}
	if closed(first) {
		t.Fatal("the abandoned handshake must not be completed by its own stale token")
	}

	a.releaseFlushWait(e, fresh)
	if !closed(second) {
		t.Fatal("the current token must still release the current waiter")
	}
}

func TestAwaitFlushReturnsWhenPageReplies(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	token, done := a.armFlushWait(e)
	go func() {
		time.Sleep(10 * time.Millisecond)
		a.releaseFlushWait(e, token)
	}()

	returned := make(chan struct{})
	go func() {
		a.awaitFlush(e.id, done, time.Now().Add(closeFlushTimeout))
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(closeFlushTimeout):
		t.Fatal("awaitFlush did not return once the page replied")
	}
}

// A deadline that has already passed — the second and later windows in a set
// where the first used up the whole budget — must not wait again.
func TestAwaitFlushReturnsImmediatelyOnAnExpiredDeadline(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	_, done := a.armFlushWait(e)

	returned := make(chan struct{})
	go func() {
		a.awaitFlush(e.id, done, time.Now().Add(-time.Second))
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("awaitFlush must not wait once the shared deadline has passed")
	}
}

// Nothing to notify (a window with no webview) must not cost a timeout.
func TestAwaitFlushReturnsImmediatelyWithoutAHandshake(t *testing.T) {
	a := newTestAppState(t)

	returned := make(chan struct{})
	go func() {
		a.awaitFlush("w1", nil, time.Now().Add(closeFlushTimeout))
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("awaitFlush must return immediately when there is no handshake pending")
	}
}
