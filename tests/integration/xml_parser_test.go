//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

func TestXMLToolCallParsing(t *testing.T) {
	// Define some test tools
	tools := []provider.ToolDefinition{
		{Name: "read_file", Description: "Read a file"},
		{Name: "write_file", Description: "Write a file"},
		{Name: "execute", Description: "Execute command"},
	}

	// Backend preserves raw text (including stray closing tags like </think>)
	// for debugging in the transaction inspector. Display-time filtering happens
	// frontend-side in message-bubble.js formatContent().

	tests := []struct {
		name     string
		input    string
		expected []provider.ContentBlock
	}{
		{
			name:  "valid tool call",
			input: "<read_file>\n<arg_key>path</arg_key>\n<arg_value>test.txt</arg_value>\n</read_file>",
			expected: []provider.ContentBlock{
				{
					Type:      provider.ContentBlockTypeToolUse,
					ToolName:  "read_file",
					ToolInput: map[string]any{"path": "test.txt"},
				},
			},
		},
		{
			name:  "text with no XML",
			input: "This is plain text with no XML tags",
			expected: []provider.ContentBlock{
				{Type: provider.ContentBlockTypeText, Content: "This is plain text with no XML tags"},
			},
		},
		{
			name:  "text followed by valid tool call",
			input: "Let me read that file.\n<read_file>\n<arg_key>path</arg_key>\n<arg_value>test.txt</arg_value>\n</read_file>",
			expected: []provider.ContentBlock{
				{Type: provider.ContentBlockTypeText, Content: "Let me read that file.\n"},
				{
					Type:      provider.ContentBlockTypeToolUse,
					ToolName:  "read_file",
					ToolInput: map[string]any{"path": "test.txt"},
				},
			},
		},
		{
			name:  "multiple tool calls",
			input: "<read_file>\n<arg_key>path</arg_key>\n<arg_value>a.txt</arg_value>\n</read_file>\n<write_file>\n<arg_key>path</arg_key>\n<arg_value>b.txt</arg_value>\n</write_file>",
			expected: []provider.ContentBlock{
				{
					Type:      provider.ContentBlockTypeToolUse,
					ToolName:  "read_file",
					ToolInput: map[string]any{"path": "a.txt"},
				},
				{Type: provider.ContentBlockTypeText, Content: "\n"},
				{
					Type:      provider.ContentBlockTypeToolUse,
					ToolName:  "write_file",
					ToolInput: map[string]any{"path": "b.txt"},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocks := []provider.ContentBlock{
				{Type: provider.ContentBlockTypeText, Content: tt.input},
			}

			result := utils.ParseXMLToolCalls(blocks, tools)

			// Verify block count
			if len(result) != len(tt.expected) {
				t.Errorf("Expected %d blocks, got %d", len(tt.expected), len(result))
				for i, block := range result {
					t.Logf("Block %d: Type=%s, Content=%q, ToolName=%s", i, block.Type, block.Content, block.ToolName)
				}
				return
			}

			// Verify each block
			for i, expected := range tt.expected {
				actual := result[i]
				if actual.Type != expected.Type {
					t.Errorf("Block %d: expected type %s, got %s", i, expected.Type, actual.Type)
				}
				if actual.Type == provider.ContentBlockTypeText {
					if actual.Content != expected.Content {
						t.Errorf("Block %d: expected content %q, got %q", i, expected.Content, actual.Content)
					}
				}
				if actual.Type == provider.ContentBlockTypeToolUse {
					if actual.ToolName != expected.ToolName {
						t.Errorf("Block %d: expected tool name %s, got %s", i, expected.ToolName, actual.ToolName)
					}
					// Check tool input (simplified comparison)
					if len(actual.ToolInput) != len(expected.ToolInput) {
						t.Errorf("Block %d: expected %d tool inputs, got %d", i, len(expected.ToolInput), len(actual.ToolInput))
					}
				}
			}
		})
	}
}
