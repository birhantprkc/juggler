//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestEmitCacheMissWarningFiltersRoutineColdStarts(t *testing.T) {
	large := strings.Repeat("context ", 20_000)
	tests := []struct {
		name     string
		req      provider.MessageRequest
		sess     *activeSession
		wantEmit bool
	}{
		{
			name: "first message in a new conversation",
			req: provider.MessageRequest{
				Messages: []provider.Message{{Type: "user", Content: large}},
			},
			wantEmit: false,
		},
		{
			name: "cleared conversation",
			req: provider.MessageRequest{
				Messages: []provider.Message{{Type: "user", Content: large}},
			},
			sess:     &activeSession{sentCount: 10},
			wantEmit: false,
		},
		{
			name: "small prior conversation",
			req: provider.MessageRequest{
				Messages: []provider.Message{
					{Type: "user", Content: "hello"},
					{Type: "assistant", Content: "hi"},
					{Type: "user", Content: "again"},
				},
			},
			sess:     &activeSession{sentCount: 2},
			wantEmit: false,
		},
		{
			name: "large cold rebuild",
			req: provider.MessageRequest{
				Messages: []provider.Message{
					{Type: "user", Content: "question"},
					{Type: "assistant", Content: large},
					{Type: "user", Content: "follow-up"},
				},
			},
			sess:     &activeSession{sentCount: 2},
			wantEmit: true,
		},
		{
			name: "large history without restored provider session",
			req: provider.MessageRequest{
				Messages: []provider.Message{
					{Type: "user", Content: "question"},
					{Type: "assistant", Content: large},
					{Type: "user", Content: "follow-up"},
				},
			},
			wantEmit: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var chunks []provider.StreamChunk
			emitCacheMissWarning(func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
				chunks = append(chunks, chunk)
				return nil, nil
			}, test.req, test.sess, "diverged: test detail")

			if got := len(chunks) == 1; got != test.wantEmit {
				t.Fatalf("warning emitted = %v, want %v (chunks=%+v)", got, test.wantEmit, chunks)
			}
			if !test.wantEmit {
				return
			}
			chunk := chunks[0]
			if chunk.Type != provider.ContentBlockTypeStatus || chunk.Content != "Rebuilding Claude Code context" {
				t.Fatalf("warning chunk = %+v", chunk)
			}
			if got, _ := chunk.Metadata["cacheMissReason"].(string); got != "diverged: test detail" {
				t.Fatalf("cacheMissReason = %q", got)
			}
		})
	}
}
