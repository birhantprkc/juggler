//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"strings"
	"testing"
)

// TestDrainStderrFiltersBenignWarnings verifies that the "matches no known
// tool" deny-rule warnings the CLI prints at startup are filtered out of
// drainStderr, while a genuine diagnostic line survives. Without this filter,
// an unrelated stall 2 minutes later would staple these startup warnings onto
// the error and make them look causal.
func TestDrainStderrFiltersBenignWarnings(t *testing.T) {
	s := &activeSession{live: &liveCLI{recentStderr: make(chan string, 8)}}
	lines := []string{
		`Permission deny rule "LS" matches no known tool — check for typos.`,
		`Permission deny rule "MultiEdit" matches no known tool — check for typos.`,
		`Permission deny rule "TodoRead" matches no known tool — check for typos.`,
		"Error: usage limit reached",
	}
	for _, l := range lines {
		s.live.recentStderr <- l
	}

	got := s.drainStderr()

	if strings.Contains(got, "matches no known tool") {
		t.Errorf("benign deny-rule warnings leaked into drainStderr output: %q", got)
	}
	if !strings.Contains(got, "usage limit reached") {
		t.Errorf("real diagnostic line was filtered out: %q", got)
	}
}

// TestDrainStderrAllBenignReturnsEmpty verifies that when stderr holds ONLY
// the benign startup warnings, drainStderr returns the empty string — so the
// stall path takes its no-stderr branch and never appends the noise.
func TestDrainStderrAllBenignReturnsEmpty(t *testing.T) {
	s := &activeSession{live: &liveCLI{recentStderr: make(chan string, 8)}}
	s.live.recentStderr <- `Permission deny rule "LS" matches no known tool — check for typos.`
	s.live.recentStderr <- `Permission deny rule "TodoRead" matches no known tool — check for typos.`

	if got := s.drainStderr(); got != "" {
		t.Errorf("expected empty drainStderr when only benign warnings present, got: %q", got)
	}
}
