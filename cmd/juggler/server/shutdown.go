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

// IsEngineConnected returns true if the engine browser is connected
func (s *Server) IsEngineConnected() bool {
	return s.engineClient.Load() != nil
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
	listener, err := net.Listen("tcp", bindAddr)
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
		listener, err := net.Listen("tcp", bindAddr)
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
