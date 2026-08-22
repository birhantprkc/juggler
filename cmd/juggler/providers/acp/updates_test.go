//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func TestToStreamChunk(t *testing.T) {
	tests := []struct {
		name     string
		update   sessionUpdate
		wantOK   bool
		wantType provider.ContentBlockType
		wantText string // exact for text/thinking; substring for status
	}{
		{
			name:     "agent message",
			update:   sessionUpdate{SessionUpdate: updAgentMessageChunk, Content: &updateContent{Type: "text", Text: "hello"}},
			wantOK:   true,
			wantType: provider.ContentBlockTypeText,
			wantText: "hello",
		},
		{
			name:     "agent thought",
			update:   sessionUpdate{SessionUpdate: updAgentThoughtChunk, Content: &updateContent{Type: "text", Text: "hmm"}},
			wantOK:   true,
			wantType: provider.ContentBlockTypeThinking,
			wantText: "hmm",
		},
		{
			name:   "empty agent message dropped",
			update: sessionUpdate{SessionUpdate: updAgentMessageChunk, Content: &updateContent{Type: "text", Text: ""}},
			wantOK: false,
		},
		{
			name:     "tool_call becomes status not tool_use",
			update:   sessionUpdate{SessionUpdate: updToolCall, ToolCallID: "t1", Title: "Write foo.go", Kind: "edit"},
			wantOK:   true,
			wantType: provider.ContentBlockTypeStatus,
			wantText: "Write foo.go",
		},
		{
			name:     "tool_call_update terminal surfaces",
			update:   sessionUpdate{SessionUpdate: updToolCallUpdate, ToolCallID: "t1", Title: "Write foo.go", Status: "completed"},
			wantOK:   true,
			wantType: provider.ContentBlockTypeStatus,
			wantText: "completed",
		},
		{
			name:   "tool_call_update non-terminal dropped",
			update: sessionUpdate{SessionUpdate: updToolCallUpdate, ToolCallID: "t1", Status: "in_progress"},
			wantOK: false,
		},
		{
			name:     "plan becomes status",
			update:   sessionUpdate{SessionUpdate: updPlan},
			wantOK:   true,
			wantType: provider.ContentBlockTypeStatus,
			wantText: "plan",
		},
		{
			name:   "user echo dropped",
			update: sessionUpdate{SessionUpdate: updUserMessageChunk, Content: &updateContent{Type: "text", Text: "hi"}},
			wantOK: false,
		},
		{
			name:   "unknown variant dropped",
			update: sessionUpdate{SessionUpdate: "available_commands_update"},
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			chunk, ok := toStreamChunk(tc.update)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if chunk.Type != tc.wantType {
				t.Fatalf("type = %q, want %q", chunk.Type, tc.wantType)
			}
			if tc.wantType == provider.ContentBlockTypeStatus {
				if !contains(chunk.Content, tc.wantText) {
					t.Fatalf("content %q does not contain %q", chunk.Content, tc.wantText)
				}
			} else if chunk.Content != tc.wantText {
				t.Fatalf("content = %q, want %q", chunk.Content, tc.wantText)
			}
		})
	}
}

// A tool_use chunk here would make the worker execute a phantom tool — the
// inversion guard. Assert no mapping ever yields tool_use.
func TestToStreamChunkNeverEmitsToolUse(t *testing.T) {
	variants := []sessionUpdate{
		{SessionUpdate: updToolCall, Title: "x"},
		{SessionUpdate: updToolCallUpdate, Status: "completed"},
		{SessionUpdate: updPlan},
	}
	for _, u := range variants {
		if chunk, ok := toStreamChunk(u); ok && chunk.Type == provider.ContentBlockTypeToolUse {
			t.Fatalf("variant %q mapped to tool_use", u.SessionUpdate)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
