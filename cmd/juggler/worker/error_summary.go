package worker

import (
	"encoding/json"
	"strings"
)

// extractErrorSummary extracts a short user-facing message from a raw error string.
// It looks for embedded JSON with a "message" field, and optionally appends a (hint: ...) suffix.
// Falls back to the original string if no structured message is found.
func extractErrorSummary(raw string) string {
	// Try to find an embedded JSON object and extract a "message" field
	start, end := findBalancedJSONObject(raw)
	if start >= 0 && end > 0 {
		jsonStr := raw[start:end]
		var parsed map[string]any
		if err := json.Unmarshal([]byte(jsonStr), &parsed); err == nil {
			if userMessage := extractMessageFromParsed(parsed); userMessage != "" {
				// Append hint suffix if present in the raw string
				if hint := extractHintSuffix(raw); hint != "" {
					userMessage += " " + hint
				}
				return userMessage
			}
		}
	}

	// Fallback: return the raw string as-is
	return raw
}

// findBalancedJSONObject locates the first embedded JSON object in raw by
// brace-balancing. It returns the [start, end) byte range of the object, or a
// start of -1 (no opening brace) / an end of -1 (no balanced closing brace).
func findBalancedJSONObject(raw string) (start, end int) {
	start = strings.IndexByte(raw, '{')
	if start < 0 {
		return -1, -1
	}

	// Find the balanced closing brace.
	depth := 0
	for i := start; i < len(raw); i++ {
		switch raw[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return start, i + 1
			}
		}
	}

	return start, -1
}

// extractMessageFromParsed digs a user-facing message out of a parsed error
// object, preferring a top-level "message" over a nested "error.message".
// Returns "" if neither is present.
func extractMessageFromParsed(parsed map[string]any) string {
	// Check top-level "message".
	if msg, ok := parsed["message"].(string); ok && msg != "" {
		return msg
	}

	// Check nested "error.message".
	if errObj, ok := parsed["error"].(map[string]any); ok {
		if msg, ok := errObj["message"].(string); ok && msg != "" {
			return msg
		}
	}

	return ""
}

// extractHintSuffix returns the "(hint: ...)" span from raw, including the
// surrounding parentheses, or "" if no complete hint is present.
func extractHintSuffix(raw string) string {
	hintStart := strings.Index(raw, "(hint:")
	if hintStart < 0 {
		return ""
	}
	rel := strings.IndexByte(raw[hintStart:], ')')
	if rel < 0 {
		return ""
	}
	return raw[hintStart : hintStart+rel+1]
}
