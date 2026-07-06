//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"fmt"
	"sync/atomic"

	"juggler/internal/jlog"
)

// TunnelMode names one WAN-exposure mechanism. The set of modes a build offers
// is whatever was registered through RegisterTunnelMode — this repository
// registers none, so the stock binary has no WAN feature.
type TunnelMode string

// TunnelInfo describes an active WAN tunnel for status/UX.
type TunnelInfo struct {
	URL         string     `json:"url"`
	Mode        TunnelMode `json:"mode"`
	Relay       bool       `json:"relay"`
	Description string     `json:"description"`
}

// TunnelProvider is one WAN-exposure mechanism. A provider instance is single-use.
type TunnelProvider interface {
	Mode() TunnelMode
	// Start brings the tunnel up and returns its public guest URL once known.
	// Long-lived servicing (reconnect loops, child supervision) runs in
	// background goroutines bounded by ctx; Start returns promptly once the URL
	// is available, or an error if startup fails.
	Start(ctx context.Context) (TunnelInfo, error)
	// Done is closed when servicing has permanently stopped (a fatal signaling
	// condition or, later, a child-process exit), so the server can clear its
	// active-tunnel slot. Providers that only stop via Stop()/ctx close it then.
	Done() <-chan struct{}
	// Stop tears down the tunnel and releases resources. Idempotent.
	Stop()
}

// activeTunnel is the server's record of the one running tunnel. The info pointer
// is populated once Start returns its public URL; ready is closed when startup
// has either succeeded (info set) or failed (err set), so concurrent callers can
// observe the same outcome.
type activeTunnel struct {
	mode     TunnelMode
	provider TunnelProvider
	info     atomic.Pointer[TunnelInfo]
	err      error
	ready    chan struct{}
	cancel   context.CancelFunc
}

// StartTunnelMode opens a WAN tunnel in the requested mode and returns its public
// guest URL. If a tunnel is already active or starting in the same mode it
// returns that one's URL rather than opening a second. A request for a different
// mode is an explicit user switch: the existing tunnel is stopped first.
func (s *Server) StartTunnelMode(mode TunnelMode) (string, error) {
	if existing := s.tunnel.Load(); existing != nil {
		if existing.mode == mode {
			return waitForTunnelReady(existing)
		}
		s.StopTunnel()
	}

	provider, err := s.newTunnelProvider(mode)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithCancel(context.Background())
	at := &activeTunnel{mode: mode, provider: provider, ready: make(chan struct{}), cancel: cancel}
	if !s.tunnel.CompareAndSwap(nil, at) {
		cancel()
		return waitForTunnelReady(s.tunnel.Load())
	}

	info, err := provider.Start(ctx)
	if err != nil {
		s.tunnel.CompareAndSwap(at, nil)
		cancel()
		at.err = err
		close(at.ready)
		jlog.Error("Tunnel: %v", err)
		return "", err
	}
	at.info.Store(&info)
	close(at.ready)

	// When the provider's servicing stops for good, clear the active-tunnel slot
	// so a later start opens a fresh one.
	go func() {
		<-provider.Done()
		if s.tunnel.CompareAndSwap(at, nil) {
			cancel()
		}
	}()

	return info.URL, nil
}

// newTunnelProvider builds a single-use provider for the requested mode by
// consulting the tunnel-mode registry (see RegisterTunnelMode).
func (s *Server) newTunnelProvider(mode TunnelMode) (TunnelProvider, error) {
	spec, ok := findTunnelMode(mode)
	if !ok {
		return nil, fmt.Errorf("unknown tunnel mode %q", mode)
	}
	if !spec.IsAvailable() {
		return nil, fmt.Errorf("tunnel mode %q is not available: %s", mode, spec.UnavailableHint)
	}
	return spec.New(tunnelHost{s}), nil
}

func waitForTunnelReady(at *activeTunnel) (string, error) {
	if at == nil {
		return "", fmt.Errorf("tunnel is not active")
	}
	<-at.ready
	if info := at.info.Load(); info != nil {
		return info.URL, nil
	}
	if at.err != nil {
		return "", at.err
	}
	return "", fmt.Errorf("tunnel failed to start")
}

// StopTunnel tears down the active or starting tunnel, if any. Cancelling the
// context and asking the provider to stop unblocks its servicing loop, which then
// exits without reconnecting.
func (s *Server) StopTunnel() {
	if at := s.tunnel.Swap(nil); at != nil {
		at.cancel()
		at.provider.Stop()
	}
}

// GetTunnelURL returns the active tunnel's guest URL, or "" if none.
func (s *Server) GetTunnelURL() string {
	if at := s.tunnel.Load(); at != nil {
		if info := at.info.Load(); info != nil {
			return info.URL
		}
	}
	return ""
}

// IsTunnelActive reports whether a tunnel is currently open or starting.
func (s *Server) IsTunnelActive() bool {
	return s.tunnel.Load() != nil
}

// GetTunnelInfo returns the active tunnel's info and true if one is up, or a zero
// value and false otherwise.
func (s *Server) GetTunnelInfo() (TunnelInfo, bool) {
	if at := s.tunnel.Load(); at != nil {
		if info := at.info.Load(); info != nil {
			return *info, true
		}
	}
	return TunnelInfo{}, false
}
