//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Production stub for worker_test_support.go. Active under -tags production
// so test-mode handlers (get-yjs-state, set-mock-responses, etc.) never enter
// the shipped binary.

//go:build production

package worker

// handleTestMessage in production is a no-op: every message hits the normal
// dispatch. The non-production build (worker_test_support.go) routes test
// messages to in-process handlers.
func (w *ConversationWorker) handleTestMessage(workerMessage) bool { return false }
