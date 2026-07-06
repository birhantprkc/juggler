//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

// TestTearDownLiveCLI_ConcurrentIsSafe is the regression test for the
// "panic: close of closed channel" crash in controlProtocol.teardown.
//
// handleCancel deliberately drives teardown from two goroutines at once when a
// turn is cancelled mid-flight: it cancels the in-flight LLM ctx (the LLM
// goroutine unwinds through finalizeTurn → dropSession → tearDownLiveCLI) AND
// calls cancelLLMSession (the conversationCache actor reaches Cancel →
// tearDownLiveCLI). Both paths reach the same activeSession. The teardown body
// closes channels (control's quit, readerStop); a plain check-then-close guard
// is not atomic, so both racers could pass the guard and double-close, panicking.
//
// The fix gates the whole body behind a per-instance teardownOnce installed by
// spawnCLIPipes. This test arms the session the same way and races N goroutines
// into tearDownLiveCLI; success is no panic and a fully torn-down session.
// Run under -race it also flags any residual data race on the live-CLI fields.
func TestTearDownLiveCLI_ConcurrentIsSafe(t *testing.T) {
	const racers = 8

	s := &activeSession{
		teardownOnce: &sync.Once{}, // armed exactly as spawnCLIPipes does
		live: &liveCLI{
			control:    newControlProtocol(&bytes.Buffer{}),
			lines:      make(chan string, 4),
			content:    make(chan string, 4),
			readerStop: make(chan struct{}),
			readerDone: make(chan struct{}),
		},
	}
	// The reader closes content+readerDone on stop; without it tearDownLiveCLI
	// would block forever waiting on readerDone.
	startStreamReader(s)

	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start             // release all racers simultaneously
			s.tearDownLiveCLI() // must not panic on the 2nd..Nth call
		}()
	}
	close(start)

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent tearDownLiveCLI deadlocked")
	}

	// Body ran exactly once and fully cleared the live-CLI plumbing (nil'd as
	// a unit).
	if s.live != nil {
		t.Errorf("live-CLI plumbing not cleared: live=%+v", s.live)
	}
}
