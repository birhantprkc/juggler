//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"juggler/internal/jlog"
)

// initiateShutdown triggers the server shutdown process
func (s *Server) initiateShutdown() {
	s.StopTunnel()
	s.shutdownOnce.Do(func() {
		close(s.shutdownChan)
	})
}

// ShutdownChan returns a channel that is closed when shutdown is requested
func (s *Server) ShutdownChan() <-chan struct{} {
	return s.shutdownChan
}

// newHTTPServer builds an http.Server with the shared handler and timeouts.
// Used for both the local listener and the tunnel, so both get
// identical keep-alive, body-limit and header-timeout behaviour.
//
// IdleTimeout caps how long an HTTP/1.1 keepalive connection can sit idle
// before being closed. Without it, every page reload leaves its prior
// connection parked in connReader.Read forever; combined with websockets
// and log/lock files we exhaust per-process fds and the next open()
// (e.g. Wails' Metal shader load) is denied.
func (s *Server) newHTTPServer() *http.Server {
	return &http.Server{
		Handler:           withBodyLimit(s.router, defaultMaxBodyBytes),
		IdleTimeout:       60 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1 MiB; default is 1 MiB but pin it explicitly.
	}
}

// Serve starts serving HTTP on the bound port (blocking)
// Must call BindPort() first
func (s *Server) Serve() error {
	if s.listener == nil {
		return fmt.Errorf("no listener bound, call BindPort() first")
	}
	return s.newHTTPServer().Serve(s.listener)
}

// GetAddr returns the bound server address (empty if not yet bound)
func (s *Server) GetAddr() string {
	return s.addr
}

// GetStaticVersion returns the random version string used for cache-busted paths
func (s *Server) GetStaticVersion() string {
	return s.staticVersion
}

// IsEngineConnected returns true if the engine browser is connected AND its JS
// realm has proved itself within the liveness window. Callers all mean "is there
// an engine that can execute a tool", and an open socket does not answer that —
// see engine_liveness.go for why the transport can outlive the realm.
func (s *Server) IsEngineConnected() bool {
	if s.engineClient.Load() == nil {
		return false
	}
	if !s.engineLive() {
		s.reportEngineSilence()
		return false
	}
	return true
}

// ActiveConversationIDs returns conversation IDs that are actively running a
// turn (excludes turns parked solely on a pending tool approval — those are
// interrupting nothing and survive a restart intact).
func (s *Server) ActiveConversationIDs() []string {
	return s.workerManager.ActiveConversationIDs()
}

// SetEngineReadyGate installs the engine-readiness gate called at the start of
// every LLM turn. Production wires this to a wait-for-connected check on the
// always-alive engine (see startEngine); tests/test-pool leave it nil (engine
// always present, gate returns true).
func (s *Server) SetEngineReadyGate(gate EngineReadyGate) {
	if gate == nil {
		s.engineReadyGate.Store(nil)
		return
	}
	s.engineReadyGate.Store(&gate)
}

// ensureEngineReady runs the engine-readiness gate if one is installed, blocking
// until the engine is connected. Returns true when the engine is ready (or no
// gate is set, e.g. in tests).
func (s *Server) ensureEngineReady() bool {
	if g := s.engineReadyGate.Load(); g != nil {
		return (*g)()
	}
	return true
}

// WaitForEngineConnected blocks until an engine client connects or the timeout
// expires. Returns true if the engine connected within the timeout.
func (s *Server) WaitForEngineConnected(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.IsEngineConnected() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown(ctx context.Context) error {
	jlog.Info("⏳ Graceful shutdown starting...")

	// 1. Stop accepting new connections
	if s.listener != nil {
		if err := s.listener.Close(); err != nil {
			jlog.Error("Error closing listener: %v", err)
		}
	}

	// 2. Notify all WebSocket clients that server is shutting down
	jlog.Info("⏳ Closing WebSocket connections...")
	s.broadcastShutdownNotice()

	// 3. Stop file watcher (no dependency on session manager or workers)
	if st := s.projectState.Load(); st != nil {
		if st.fileWatcher != nil {
			jlog.Info("⏳ Stopping file watcher...")
			st.fileWatcher.Stop()
		}
	}

	// 4. Stop workers before session manager — workers call SaveConversationBinary
	// on shutdown, which routes through the session manager actor. If the session
	// manager is stopped first, those saves deadlock waiting for a response.
	if s.workerManager != nil {
		s.workerManager.Shutdown()
	}

	// 4a. After workers are quiescent, close every cached Conversation so
	// provider-side resources (CLI subprocesses, sockets, etc.) get
	// released cleanly. Ordered after worker shutdown so no in-flight
	// LLM call races a closing handle.
	if s.conversationCache != nil {
		s.conversationCache.Shutdown()
	}

	// 5. Now safe to shut down session manager and release lock
	if st := s.projectState.Load(); st != nil {
		if st.sessionManager != nil {
			jlog.Info("⏳ Shutting down session manager...")
			st.sessionManager.Shutdown()
		}
		if st.lock != nil {
			_ = st.lock.Release()
		}
	}

	jlog.Info("✅ Graceful shutdown complete")
	return nil
}

// broadcastShutdownNotice sends a shutdown notification to all connected WebSocket clients
func (s *Server) broadcastShutdownNotice() {
	s.shutdownAllClients()
}

// viewerListenConfig is how the port that serves viewers is bound.
//
// Keep-alive probes are enabled with an explicit period so a peer whose host
// simply vanished — a suspended laptop, a dropped tunnel, a killed VM — gets
// reaped by the kernel instead of lingering as a half-open connection holding
// an fd and a registered WSClient. Nothing above the transport can notice such
// a peer on its own: it never sends, so no read fails, and a write to it only
// fails if there is something to send (see wsWriteTimeout). Probes are the
// only thing that detects a silent idle client that is already gone.
//
// Idle 30s then 9 probes 10s apart declares the connection dead about two
// minutes after the peer disappears, for two packets a minute on a live idle
// connection. The listener binds all interfaces, so these settings also apply
// to loopback peers (the engine, local viewers); that is harmless, since a
// loopback peer cannot go half-open without its process dying, and probes that
// never leave the machine cost nothing.
var viewerListenConfig = net.ListenConfig{
	KeepAliveConfig: net.KeepAliveConfig{
		Enable:   true,
		Idle:     30 * time.Second,
		Interval: 10 * time.Second,
		Count:    9,
	},
}

// listenForViewers binds bindAddr with the viewer keep-alive settings.
func listenForViewers(bindAddr string) (net.Listener, error) {
	return viewerListenConfig.Listen(context.Background(), "tcp", bindAddr)
}

// findAvailablePort tries to bind to the configured port, or finds an available one
func (s *Server) findAvailablePort() (net.Listener, string, error) {
	// Parse the configured address
	host, portStr, err := net.SplitHostPort(s.addr)
	if err != nil {
		return nil, "", fmt.Errorf("invalid address: %w", err)
	}

	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, "", fmt.Errorf("invalid port: %w", err)
	}

	// Always bind to all interfaces so LAN gate middleware can control access.
	// The display address (returned as the second value) keeps the configured
	// hostname so the banner shows "localhost" rather than "0.0.0.0".
	bindAddr := net.JoinHostPort("", portStr)
	listener, err := listenForViewers(bindAddr)
	if err == nil {
		_, actualPort, _ := net.SplitHostPort(listener.Addr().String())
		return listener, net.JoinHostPort(host, actualPort), nil
	}

	// If configured port is busy, try finding an available one
	jlog.Info("⚠️  Port %d is busy, searching for available port...", port)

	maxAttempts := 10
	for range maxAttempts {
		port++
		bindAddr := net.JoinHostPort("", strconv.Itoa(port))
		displayAddr := net.JoinHostPort(host, strconv.Itoa(port))
		listener, err := listenForViewers(bindAddr)
		if err == nil {
			jlog.Info("✅ Found available port: %d", port)
			return listener, displayAddr, nil
		}

		// Only continue for "address already in use" errors
		if !strings.Contains(err.Error(), "address already in use") {
			return nil, "", err
		}
	}

	return nil, "", fmt.Errorf("could not find available port after %d attempts", maxAttempts)
}
