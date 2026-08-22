//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"math"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func TestNewClientClampsMaxOutputTokensAboveInt32(t *testing.T) {
	// N4: a garbage over-large live-list value must not make the provider
	// un-initializable — it clamps to the int32 wire ceiling instead of erroring.
	p, err := NewClient(provider.Config{
		APIKey: "test",
		Model:  "gemini-test",
		ModelCapabilities: provider.ModelCapabilities{
			MaxOutputTokens: int64(math.MaxInt32) + 1,
		},
	})
	if err != nil {
		t.Fatalf("NewClient error = %v, want a clamped client, not a failure", err)
	}
	c, ok := p.(*Client)
	if !ok {
		t.Fatalf("NewClient returned %T, want *Client", p)
	}
	if c.maxOutputTokens != math.MaxInt32 {
		t.Fatalf("maxOutputTokens = %d, want clamped to %d", c.maxOutputTokens, int32(math.MaxInt32))
	}
}

func TestPrepareRequestUsesAdmissionMaxOutputTokens(t *testing.T) {
	c := &Client{model: "gemini-test", maxOutputTokens: 12345}
	config, _, err := c.prepareRequest(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatalf("prepareRequest: %v", err)
	}
	if config.MaxOutputTokens != 12345 {
		t.Fatalf("MaxOutputTokens = %d, want 12345", config.MaxOutputTokens)
	}
}

func TestPrepareRequestLeavesMaxOutputTokensUnsetWithoutCapability(t *testing.T) {
	c := &Client{model: "gemini-test"}
	config, _, err := c.prepareRequest(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatalf("prepareRequest: %v", err)
	}
	if config.MaxOutputTokens != 0 {
		t.Fatalf("MaxOutputTokens = %d, want API default 0", config.MaxOutputTokens)
	}
}
