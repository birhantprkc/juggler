//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"encoding/json"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

func TestConvertToolChoiceChat(t *testing.T) {
	if _, ok := convertToolChoiceChat(nil, false); ok {
		t.Error("nil → auto (ok=false)")
	}

	tc, ok := convertToolChoiceChat(&provider.ToolChoice{Mode: provider.ToolChoiceTool, Name: "return_result"}, false)
	if !ok {
		t.Fatal("tool mode must be ok")
	}
	js := mustJSON(t, tc)
	if !strings.Contains(js, `"type":"function"`) || !strings.Contains(js, `"name":"return_result"`) {
		t.Errorf("chat forced-tool JSON = %s", js)
	}

	if _, ok := convertToolChoiceChat(&provider.ToolChoice{Mode: provider.ToolChoiceTool}, false); ok {
		t.Error("nameless tool mode must be unset")
	}

	tc, _ = convertToolChoiceChat(&provider.ToolChoice{Mode: provider.ToolChoiceAny}, false)
	if js := mustJSON(t, tc); !strings.Contains(js, "required") {
		t.Errorf("any → %s, want required", js)
	}
	tc, _ = convertToolChoiceChat(&provider.ToolChoice{Mode: provider.ToolChoiceNone}, false)
	if js := mustJSON(t, tc); !strings.Contains(js, "none") {
		t.Errorf("none → %s, want none", js)
	}
}

// TestConvertToolChoiceChatDowngradesForcedTool pins the ForcedToolChoiceUnsupported
// path: a named single-tool force is mapped to auto (ok=false) while required and
// none are left intact, so only the forced-single-tool case a thinking model
// rejects is relaxed.
func TestConvertToolChoiceChatDowngradesForcedTool(t *testing.T) {
	forced := &provider.ToolChoice{Mode: provider.ToolChoiceTool, Name: "return_result"}

	if _, ok := convertToolChoiceChat(forced, false); !ok {
		t.Fatal("forced tool must stay forced when the vendor supports it")
	}

	if tc, ok := convertToolChoiceChat(forced, true); ok {
		t.Errorf("forced tool must downgrade to auto, got %s", mustJSON(t, tc))
	}

	if tc, ok := convertToolChoiceChat(&provider.ToolChoice{Mode: provider.ToolChoiceAny}, true); !ok || !strings.Contains(mustJSON(t, tc), "required") {
		t.Errorf("any must stay required under downgrade, got ok=%v", ok)
	}
	if tc, ok := convertToolChoiceChat(&provider.ToolChoice{Mode: provider.ToolChoiceNone}, true); !ok || !strings.Contains(mustJSON(t, tc), "none") {
		t.Errorf("none must stay none under downgrade, got ok=%v", ok)
	}
}

func TestConvertToolChoiceResponses(t *testing.T) {
	if _, ok := convertToolChoiceResponses(nil); ok {
		t.Error("nil → auto (ok=false)")
	}

	tc, ok := convertToolChoiceResponses(&provider.ToolChoice{Mode: provider.ToolChoiceTool, Name: "return_result"})
	if !ok {
		t.Fatal("tool mode must be ok")
	}
	js := mustJSON(t, tc)
	if !strings.Contains(js, `"type":"function"`) || !strings.Contains(js, `"name":"return_result"`) {
		t.Errorf("responses forced-tool JSON = %s", js)
	}

	if _, ok := convertToolChoiceResponses(&provider.ToolChoice{Mode: provider.ToolChoiceTool}); ok {
		t.Error("nameless tool mode must be unset")
	}

	tc, _ = convertToolChoiceResponses(&provider.ToolChoice{Mode: provider.ToolChoiceAny})
	if js := mustJSON(t, tc); !strings.Contains(js, "required") {
		t.Errorf("any → %s, want required", js)
	}
	tc, _ = convertToolChoiceResponses(&provider.ToolChoice{Mode: provider.ToolChoiceNone})
	if js := mustJSON(t, tc); !strings.Contains(js, "none") {
		t.Errorf("none → %s, want none", js)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}
