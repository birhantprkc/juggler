//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"strings"
	"testing"
)

// fakeTunnelProvider is a no-op TunnelProvider for registry-dispatch tests.
type fakeTunnelProvider struct {
	mode TunnelMode
	host TunnelHost
	done chan struct{}
}

func (p *fakeTunnelProvider) Mode() TunnelMode      { return p.mode }
func (p *fakeTunnelProvider) Done() <-chan struct{} { return p.done }
func (p *fakeTunnelProvider) Stop()                 {}
func (p *fakeTunnelProvider) Start(context.Context) (TunnelInfo, error) {
	return TunnelInfo{Mode: p.mode}, nil
}

// withTestTunnelModes swaps the registry for the duration of a test. The
// registry is a startup-time package global, so tests that exercise it must
// save/restore rather than leak modes into other tests.
func withTestTunnelModes(t *testing.T, specs ...TunnelModeSpec) {
	t.Helper()
	saved := tunnelModeRegistry
	tunnelModeRegistry = nil
	for _, spec := range specs {
		RegisterTunnelMode(spec)
	}
	t.Cleanup(func() { tunnelModeRegistry = saved })
}

// TestTunnelRegistryDispatch verifies newTunnelProvider consults the registry:
// a registered mode gets its factory's provider (handed the host capability),
// an unknown mode errors, and an unavailable mode errors with its hint.
func TestTunnelRegistryDispatch(t *testing.T) {
	withTestTunnelModes(t,
		TunnelModeSpec{
			Mode: "fake",
			New: func(host TunnelHost) TunnelProvider {
				return &fakeTunnelProvider{mode: "fake", host: host, done: make(chan struct{})}
			},
		},
		TunnelModeSpec{
			Mode:            "gone",
			UnavailableHint: "install the gone helper",
			Available:       func() bool { return false },
			New: func(host TunnelHost) TunnelProvider {
				return &fakeTunnelProvider{mode: "gone", host: host, done: make(chan struct{})}
			},
		},
	)
	s := &Server{}

	p, err := s.newTunnelProvider("fake")
	if err != nil {
		t.Fatalf("registered mode: unexpected error %v", err)
	}
	fake, ok := p.(*fakeTunnelProvider)
	if !ok {
		t.Fatalf("registered mode: got %T, want *fakeTunnelProvider", p)
	}
	if fake.host == nil {
		t.Fatal("factory must receive a non-nil TunnelHost")
	}

	if _, err := s.newTunnelProvider("bogus"); err == nil {
		t.Fatal("unknown mode should return an error")
	}

	if _, err := s.newTunnelProvider("gone"); err == nil {
		t.Fatal("unavailable mode should return an error")
	} else if want := "install the gone helper"; !strings.Contains(err.Error(), want) {
		t.Fatalf("unavailable error %q should contain the spec's hint %q", err, want)
	}
}

// TestRegisterTunnelModeValidation verifies invalid and duplicate registrations
// fail loudly at startup rather than being silently accepted.
func TestRegisterTunnelModeValidation(t *testing.T) {
	withTestTunnelModes(t)

	mustPanic := func(name string, fn func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Fatalf("%s: expected panic", name)
			}
		}()
		fn()
	}

	mustPanic("missing mode", func() {
		RegisterTunnelMode(TunnelModeSpec{New: func(TunnelHost) TunnelProvider { return nil }})
	})
	mustPanic("missing factory", func() {
		RegisterTunnelMode(TunnelModeSpec{Mode: "x"})
	})

	RegisterTunnelMode(TunnelModeSpec{Mode: "x", New: func(TunnelHost) TunnelProvider { return nil }})
	mustPanic("duplicate mode", func() {
		RegisterTunnelMode(TunnelModeSpec{Mode: "x", New: func(TunnelHost) TunnelProvider { return nil }})
	})
}
