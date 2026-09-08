//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

// A context/tools round-trip that misses ContextTimeout ends the turn with
// "context/tools request timed out", and until the reply carries stamps there
// is nothing anywhere saying which stage spent the 30s. These pin the split.

func TestDescribeRoundTripNamesEachStage(t *testing.T) {
	payload := json.RawMessage(`{"requestId":"r1","sentAt":1000,"receivedAt":1200,"repliedAt":31000}`)
	desc, ok := describeRoundTrip(payload, 31100)
	if !ok {
		t.Fatalf("a fully stamped reply must describe itself, got ok=false")
	}
	// 200ms getting there, 29800ms in the engine, 100ms coming back.
	for _, want := range []string{"30100ms", "200ms", "29800ms", "100ms"} {
		if !strings.Contains(desc, want) {
			t.Errorf("description %q missing %q", desc, want)
		}
	}
}

func TestDescribeRoundTripIgnoresUnstampedReplies(t *testing.T) {
	// Not every slot carries stamps (strategy hooks, subthread specs), and an
	// engine mid-upgrade may answer without them. Reporting a half-measurement
	// as though it were a timing would be worse than reporting nothing.
	cases := map[string]string{
		"no stamps at all":  `{"requestId":"r1"}`,
		"only sentAt":       `{"requestId":"r1","sentAt":1000}`,
		"missing repliedAt": `{"requestId":"r1","sentAt":1000,"receivedAt":1200}`,
		"zero sentAt":       `{"requestId":"r1","sentAt":0,"receivedAt":1200,"repliedAt":1300}`,
		"not json":          `garbage`,
	}
	for name, payload := range cases {
		if desc, ok := describeRoundTrip(json.RawMessage(payload), 2000); ok {
			t.Errorf("%s: expected no description, got %q", name, desc)
		}
	}
}

func TestDescribeRoundTripRejectsStampsOutOfOrder(t *testing.T) {
	// Rather than print a negative duration and send someone hunting a stage
	// that never happened.
	payload := json.RawMessage(`{"requestId":"r1","sentAt":5000,"receivedAt":1200,"repliedAt":1300}`)
	if desc, ok := describeRoundTrip(payload, 9000); ok {
		t.Errorf("expected stamps out of order to be refused, got %q", desc)
	}
}

func TestDescribeRoundTripSurvivesALateReply(t *testing.T) {
	// The reply that arrives after the worker gave up is the most valuable one
	// there is: it is the only record of where a timed-out turn's 30s went.
	payload := json.RawMessage(`{"requestId":"r1","sentAt":1000,"receivedAt":1050,"repliedAt":46000}`)
	desc, ok := describeRoundTrip(payload, 46010)
	if !ok {
		t.Fatalf("a late reply must still describe itself")
	}
	if !strings.Contains(desc, "44950ms") {
		t.Errorf("description %q should charge the 44950ms to the engine", desc)
	}
}

func TestRoundTripSlowEnoughToReport(t *testing.T) {
	if roundTripIsSlow(slowRoundTripMS - 1) {
		t.Errorf("a round-trip under the threshold must not be reported")
	}
	if !roundTripIsSlow(slowRoundTripMS) {
		t.Errorf("a round-trip at the threshold must be reported")
	}
}
