//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"errors"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestQuickCompleteRejectsBlankRequest verifies the cheap guards fire before any
// provider work: a missing model or prompt is an immediate error.
func TestQuickCompleteRejectsBlankRequest(t *testing.T) {
	s := &Server{quickCompleteSem: make(chan struct{}, quickCompleteConcurrency)}

	if _, err := s.QuickComplete(context.Background(), QuickCompleteRequest{Prompt: "hi"}); err == nil {
		t.Fatal("expected error for missing model")
	}
	if _, err := s.QuickComplete(context.Background(), QuickCompleteRequest{
		Model: core.ModelRef{Provider: "p", Model: "m"},
	}); err == nil {
		t.Fatal("expected error for empty prompt")
	}
}

// TestQuickCompleteConcurrencyLimiter verifies an over-cap caller is rejected
// fast with ErrQuickCompleteBusy rather than queued.
func TestQuickCompleteConcurrencyLimiter(t *testing.T) {
	s := &Server{quickCompleteSem: make(chan struct{}, quickCompleteConcurrency)}
	// Saturate every slot.
	for i := 0; i < quickCompleteConcurrency; i++ {
		s.quickCompleteSem <- struct{}{}
	}
	_, err := s.QuickComplete(context.Background(), QuickCompleteRequest{
		Model:  core.ModelRef{Provider: "p", Model: "m"},
		Prompt: "name this task",
	})
	if !errors.Is(err, ErrQuickCompleteBusy) {
		t.Fatalf("expected ErrQuickCompleteBusy, got %v", err)
	}
}
