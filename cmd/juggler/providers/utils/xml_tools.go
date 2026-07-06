//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"encoding/xml"
	"fmt"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// XMLArg represents an argument in XML tool call format
type XMLArg struct {
	XMLName xml.Name
	Value   string `xml:",chardata"`
}

// XMLToolCall represents a tool call in XML format
type XMLToolCall struct {
	XMLName xml.Name
	Args    []XMLArg `xml:",any"`
}

// ParseXMLToolCalls scans ContentBlocks for XML-style tool calls in text blocks
// and converts them to proper ToolUse blocks. Only parses well-formed XML that
// matches registered tool names.
func ParseXMLToolCalls(blocks []provider.ContentBlock, tools []provider.ToolDefinition) []provider.ContentBlock {
	if len(blocks) == 0 {
		return blocks
	}

	// Build set of valid tool names for validation
	toolNames := make(map[string]bool)
	for _, tool := range tools {
		toolNames[tool.Name] = true
	}

	result := make([]provider.ContentBlock, 0, len(blocks))

	for _, block := range blocks {
		if block.Type != provider.ContentBlockTypeText {
			result = append(result, block)
			continue
		}

		// Try to parse XML tool calls from text content
		parsed := parseTextForXMLTools(block.Content, toolNames)
		result = append(result, parsed...)
	}

	return result
}

// parseTextForXMLTools scans text for XML tool calls and converts them to blocks
func parseTextForXMLTools(text string, validToolNames map[string]bool) []provider.ContentBlock {
	blocks := make([]provider.ContentBlock, 0)
	remaining := text

	for {
		// Find next potential XML opening tag
		startIdx := strings.Index(remaining, "<")
		if startIdx == -1 {
			// No more XML tags, add remaining text if non-empty
			if len(remaining) > 0 {
				blocks = append(blocks, provider.ContentBlock{
					Type:    provider.ContentBlockTypeText,
					Content: remaining,
				})
			}
			break
		}

		// Add text before XML as text block
		if startIdx > 0 {
			blocks = append(blocks, provider.ContentBlock{
				Type:    provider.ContentBlockTypeText,
				Content: remaining[:startIdx],
			})
		}

		// Try to extract and parse XML tool call
		toolCall, endIdx, ok := extractXMLToolCall(remaining[startIdx:], validToolNames)
		if !ok {
			// Not a valid XML tool call, treat opening bracket as text
			blocks = append(blocks, provider.ContentBlock{
				Type:    provider.ContentBlockTypeText,
				Content: remaining[startIdx : startIdx+1],
			})
			remaining = remaining[startIdx+1:]
			continue
		}

		// Successfully parsed XML tool call
		blocks = append(blocks, toolCall)
		remaining = remaining[startIdx+endIdx:]
	}

	return blocks
}

// extractXMLToolCall attempts to extract and parse an XML tool call starting at the beginning of text
// Returns the parsed ContentBlock, the end index, and whether extraction was successful
func extractXMLToolCall(text string, validToolNames map[string]bool) (provider.ContentBlock, int, bool) {
	// Find the closing tag by scanning for matching tags
	// We need to handle nested tags properly
	if !strings.HasPrefix(text, "<") {
		return provider.ContentBlock{}, 0, false
	}

	// Extract tag name from opening tag
	tagEnd := strings.IndexAny(text[1:], "> \t\n")
	if tagEnd == -1 {
		return provider.ContentBlock{}, 0, false
	}
	tagName := text[1 : tagEnd+1]

	// Check if this is a valid tool name
	if !validToolNames[tagName] {
		return provider.ContentBlock{}, 0, false
	}

	// Find the closing tag
	closingTag := "</" + tagName + ">"
	endIdx := strings.Index(text, closingTag)
	if endIdx == -1 {
		return provider.ContentBlock{}, 0, false
	}

	// Extract the complete XML fragment
	xmlFragment := text[:endIdx+len(closingTag)]

	// Try to parse with encoding/xml
	var toolCall XMLToolCall
	if err := xml.Unmarshal([]byte(xmlFragment), &toolCall); err != nil {
		// XML is malformed, not a valid tool call
		return provider.ContentBlock{}, 0, false
	}

	// Convert arg_key/arg_value pairs to map
	toolInput := make(map[string]any)
	var currentKey string

	for _, arg := range toolCall.Args {
		switch arg.XMLName.Local {
		case "arg_key":
			currentKey = arg.Value
		case "arg_value":
			if currentKey != "" {
				toolInput[currentKey] = arg.Value
				currentKey = "" // Reset for next pair
			}
		}
	}

	// Generate unique tool use ID
	toolUseID := fmt.Sprintf("toolu_xml_%d", time.Now().UnixNano())

	block := provider.ContentBlock{
		Type:      provider.ContentBlockTypeToolUse,
		Content:   "",
		ToolUseID: toolUseID,
		ToolName:  toolCall.XMLName.Local,
		ToolInput: toolInput,
	}

	return block, endIdx + len(closingTag), true
}
