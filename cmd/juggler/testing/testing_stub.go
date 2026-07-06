//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Production stub for cmd/juggler/testing. Provides the minimal surface
// app_phases.go references (NewTestService) so the package compiles under
// -tags production without dragging the real test handlers into the binary.
// In production a.flags.testMode is never true, so the value is never used —
// the stub returns nil and RegisterTestRoutes (which takes `any`) tolerates it.

//go:build production

package testing

// TestService is a stub in production builds — the real type lives in
// test_run_api.go and is only compiled when -tags production is NOT set.
type TestService struct{}

// NewTestService returns nil in production builds. The caller wraps the
// returned value in RegisterTestRoutes, which accepts `any` — and is only
// invoked when a.flags.testMode is set, which is false in production.
func NewTestService(_ string, _ any) *TestService { return nil }
