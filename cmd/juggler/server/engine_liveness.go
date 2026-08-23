//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"time"

	"juggler/internal/jlog"
)

// Engine liveness: proof that the engine's JS realm is still running, as
// distinct from proof that its socket is still open.
//
// The engine is the only thing that executes tools, and the worker's
// tool-command driver acts only while the server reports an engine attached. A
// presence check is not enough to carry that weight. The engine runs in a hidden
// WebView whose realm can stop — suspended while backgrounded, wedged, or killed
// and reloaded underneath us — and in WebKit the WebSocket lives in the network
// process, so the transport keeps completing handshakes and answering control
// frames long after the realm above it has gone quiet. A ping-based keepalive
// therefore proves the wrong thing: it can be answered by a machine whose engine
// is dead.
//
// So the engine proves itself the only way that cannot be faked from below: it
// sends an engine-heartbeat from inside its module worker (see
// web/js/engine-app.js), the realm that would have to be running for a tool to
// execute at all. The stamp is refreshed by that heartbeat and by every other
// message the engine sends, since traffic is proof of the same thing.
const (
	// engineHeartbeatInterval is how often the engine announces itself. Kept well
	// inside engineLivenessWindow so an ordinary scheduling hiccup, a slow
	// reconnect, or one dropped beat never reads as death.
	engineHeartbeatInterval = 5 * time.Second

	// engineLivenessWindow is how long the engine may stay silent before it stops
	// counting as attached. Six missed beats, which is deliberately generous: a
	// machine under enough load to starve the engine's worker for half a minute
	// is not a machine that should also be told its engine is dead, and the
	// worker holds an unproven tool for engineUnprovenHold anyway — so nothing is
	// gained by condemning faster, and a false eviction costs a real reconnect.
	engineLivenessWindow = 30 * time.Second
)

// noteEngineAlive stamps the moment the engine last proved its realm is running.
// Called on engine registration (a fresh connection has, by definition, just run
// the code that opened it) and on every inbound engine message.
func (s *Server) noteEngineAlive() {
	s.engineHeartbeatAt.Store(time.Now().UnixNano())
}

// livenessWindow is engineLivenessWindow unless a test has shortened it.
func (s *Server) livenessWindow() time.Duration {
	if override := s.engineLivenessWindowNs.Load(); override > 0 {
		return time.Duration(override)
	}
	return engineLivenessWindow
}

// setEngineLivenessWindow shortens the staleness window so tests need not wait
// out the production one. Test-only seam.
func (s *Server) setEngineLivenessWindow(d time.Duration) {
	s.engineLivenessWindowNs.Store(int64(d))
}

// engineSilence reports how long the engine has been silent. Zero when no engine
// is registered (the caller checks registration first).
func (s *Server) engineSilence() time.Duration {
	last := s.engineHeartbeatAt.Load()
	if last == 0 {
		return 0
	}
	return time.Since(time.Unix(0, last))
}

// engineLive reports whether a registered engine has proved itself within the
// liveness window. This is the predicate behind IsEngineConnected: everything
// gating a turn on "is there an engine" means "is there an engine that can still
// execute a tool", and a socket alone does not answer that.
func (s *Server) engineLive() bool {
	if s.engineClient.Load() == nil {
		return false
	}
	return s.engineSilence() <= s.livenessWindow()
}

// engineWentQuiet is the one-shot log line for an engine crossing from live to
// silent. Rate-limited to the transition so a wedged engine costs one line, not
// one per poll.
func (s *Server) reportEngineSilence() {
	if s.engineSilenceReported.Swap(true) {
		return
	}
	queued := 0
	if c := s.engineClient.Load(); c != nil {
		queued = c.QueuedWrites()
	}
	jlog.Error("[engine] silent for %v (queued writes: %d) — the engine socket is still open but its realm "+
		"has stopped answering; tools cannot execute until it returns",
		s.engineSilence().Round(time.Second), queued)
}

// EngineRecovery brings a dead engine back. The server can close a wedged
// engine's socket, but it cannot reload the WebView that hosts it — that needs
// the native window, which lives in the app layer. startEngineHost installs this
// hook; without one, recovery stops at eviction.
type EngineRecovery func()

// SetEngineRecovery installs the hook used when a silent engine fails to
// reconnect on its own. Optional: with no hook the server still evicts, which is
// enough whenever the realm is alive and only the link had wedged.
func (s *Server) SetEngineRecovery(fn EngineRecovery) {
	if fn == nil {
		s.engineRecovery.Store(nil)
		return
	}
	s.engineRecovery.Store(&fn)
}

const (
	// engineReconnectGrace is how long an evicted engine is given to come back on
	// its own before the recovery hook is called. The client reconnects on a 1s
	// tiered backoff, so this is many attempts' worth: if it has not returned by
	// now, the realm itself is gone rather than the link.
	engineReconnectGrace = 20 * time.Second

	// maxEngineRecoveries caps how many times the recovery hook fires before the
	// server stops trying. An engine that cannot be revived is a broken install or
	// a broken WebKit, and hammering it helps nobody; turns fail with a clear
	// engine-unavailable error either way, which beats a reload loop.
	maxEngineRecoveries = 3
)

// startEngineSupervisor watches the engine link for the failure no other check
// can see: a socket that stays open while the realm behind it has stopped.
//
// The escalation is deliberately gentle, because each step costs more than the
// last. First evict — close the socket, which the client answers with a
// reconnect, healing the common case (a wedged or half-open link over a healthy
// realm) in about a second and costing nothing else. Only if nothing comes back
// is the realm itself presumed dead and the recovery hook called to reload it.
func (s *Server) startEngineSupervisor() {
	go func() {
		tick := time.NewTicker(engineHeartbeatInterval)
		defer tick.Stop()
		for {
			select {
			case <-s.shutdownChan:
				return
			case <-tick.C:
				s.superviseEngine()
			}
		}
	}()
}

// superviseEngine is one supervision tick. Split out so a test can step it
// without waiting on the ticker.
func (s *Server) superviseEngine() {
	if s.engineClient.Load() != nil {
		if s.engineLive() {
			// Healthy: forget any eviction we were tracking.
			s.engineEvictedAt.Store(0)
			s.engineRecoveries.Store(0)
			return
		}
		s.evictSilentEngine()
		return
	}

	// No engine attached. Only act on one WE evicted: an engine that has never
	// connected is startEngineHost's business, and a normal disconnect during
	// shutdown is nobody's.
	evictedAt := s.engineEvictedAt.Load()
	if evictedAt == 0 || time.Since(time.Unix(0, evictedAt)) < engineReconnectGrace {
		return
	}
	s.engineEvictedAt.Store(0)

	if n := s.engineRecoveries.Add(1); n > maxEngineRecoveries {
		jlog.Error("[engine] gave up reviving the engine after %d attempts — tools cannot run in this session", maxEngineRecoveries)
		return
	}
	g := s.engineRecovery.Load()
	if g == nil {
		jlog.Error("[engine] evicted engine did not reconnect within %v and no recovery hook is installed", engineReconnectGrace)
		return
	}
	jlog.Info("[engine] evicted engine did not reconnect within %v — reloading it", engineReconnectGrace)
	(*g)()
}

// evictSilentEngine closes a wedged engine's socket. Closing is what makes the
// rest of the system honest: the read loop unblocks, ClearEngineClient runs, and
// the worker's engineAttached — which gates every tool-command dispatch — stops
// claiming an engine that cannot act. The client's own reconnect backoff brings
// a live realm straight back.
func (s *Server) evictSilentEngine() {
	client := s.engineClient.Load()
	if client == nil {
		return
	}
	if s.engineEvictedAt.Load() != 0 {
		return // already evicted this one; waiting out the reconnect grace
	}
	s.engineEvictedAt.Store(time.Now().UnixNano())
	jlog.Error("[engine] evicting a silent engine after %v with no word from its realm "+
		"(client=%s, queued writes: %d); closing the socket so it reconnects",
		s.engineSilence().Round(time.Second), client.ClientID(), client.QueuedWrites())
	client.Close()
}
