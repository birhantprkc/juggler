package worker

import "testing"

func TestFindBalancedJSONObject(t *testing.T) {
	cases := []struct {
		name               string
		raw                string
		wantStart, wantEnd int
	}{
		{"no brace", "plain error", -1, -1},
		{"simple", `{"a":1}`, 0, 7},
		{"embedded", `prefix {"a":1} suffix`, 7, 14},
		{"nested", `x {"a":{"b":2}} y`, 2, 15},
		{"unbalanced", `oops {"a":1`, 5, -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			start, end := findBalancedJSONObject(c.raw)
			if start != c.wantStart || end != c.wantEnd {
				t.Fatalf("got (%d, %d), want (%d, %d)", start, end, c.wantStart, c.wantEnd)
			}
		})
	}
}

func TestExtractMessageFromParsed(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]any
		want string
	}{
		{"top-level", map[string]any{"message": "boom"}, "boom"},
		{"nested", map[string]any{"error": map[string]any{"message": "nested"}}, "nested"},
		{"prefers top-level", map[string]any{"message": "top", "error": map[string]any{"message": "n"}}, "top"},
		{"empty top-level falls through", map[string]any{"message": "", "error": map[string]any{"message": "n"}}, "n"},
		{"none", map[string]any{"code": 500}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractMessageFromParsed(c.in); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestExtractHintSuffix(t *testing.T) {
	cases := []struct {
		name, raw, want string
	}{
		{"none", "no hint here", ""},
		{"complete", "failed (hint: try again)", "(hint: try again)"},
		{"unterminated", "failed (hint: try again", ""},
		{"trailing text", "x (hint: do it) more", "(hint: do it)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractHintSuffix(c.raw); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestExtractErrorSummary(t *testing.T) {
	cases := []struct {
		name, raw, want string
	}{
		{"plain passthrough", "just a string", "just a string"},
		{"json message", `API error: {"message":"rate limited"}`, "rate limited"},
		{"json message with hint", `{"message":"bad"} (hint: retry)`, "bad (hint: retry)"},
		{"nested error message", `{"error":{"message":"deep"}}`, "deep"},
		{"json without message passes through", `{"code":500}`, `{"code":500}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractErrorSummary(c.raw); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
