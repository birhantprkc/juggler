package worker

import (
	"encoding/json"
	"testing"
)

func TestUnofferedToolCallProducesPairedRefusal(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.turn.offeredTools = map[string]bool{"read": true}

	shouldContinue, err := w.processLLMResponse(&LLMResponse{
		Blocks: []LLMResponseBlock{{
			Type:  "tool_use",
			ID:    "tool-1",
			Name:  "Research",
			Input: json.RawMessage(`{"task":"look it up"}`),
		}},
		StopReason: "tool_use",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !shouldContinue {
		t.Fatal("a paired refusal must continue the loop")
	}

	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("want one refusal, got %+v", items)
	}
	item := items[0]
	if item.Type != ItemTypeMetaToolResult || item.ToolUseID != "tool-1" || item.ToolName != "Research" || !item.IsError {
		t.Fatalf("want paired Research error result, got %+v", item)
	}
	var result struct {
		Content string `json:"content"`
		IsError bool   `json:"isError"`
	}
	if err := json.Unmarshal(item.Result, &result); err != nil {
		t.Fatal(err)
	}
	const want = `Tool "Research" wasn't available in this thread, so it wasn't run.`
	if result.Content != want || !result.IsError {
		t.Fatalf("result = %+v, want content %q and isError", result, want)
	}
}

func TestOfferedToolAliasesRemainAccepted(t *testing.T) {
	cases := []struct {
		offered string
		called  string
		want    bool
	}{
		{"bash", "Bash", true},
		{"read", "Read", true},
		{"batch_grep", "BatchGrep", true},
		{"query_code", "ExploreCode", true},
		{"query_code", "explore_code", true},
		{"read", "mcp__juggler__read", true},
		{"read", "mcp__juggler__mcp__juggler__Read", true},
		{"mcp__github__create_issue", "mcp__github__create_issue", true},
		{"read", "READ", false},
		{"read", "mcp__other__read", false},
	}
	for _, tc := range cases {
		t.Run(tc.called, func(t *testing.T) {
			w := &ConversationWorker{turn: &turnState{offeredTools: collectOfferedToolNames([]ToolDefinition{{Name: tc.offered}})}}
			if got := w.toolWasOfferedThisTurn(tc.called); got != tc.want {
				t.Fatalf("offered %q, called %q: got %v, want %v", tc.offered, tc.called, got, tc.want)
			}
		})
	}
}

func TestOfferedToolSnapshotNilAndEmpty(t *testing.T) {
	if !(&ConversationWorker{turn: newTurnState()}).toolWasOfferedThisTurn("Research") {
		t.Fatal("nil snapshot must preserve direct response-processing paths")
	}
	if (&ConversationWorker{turn: &turnState{offeredTools: map[string]bool{}}}).toolWasOfferedThisTurn("Research") {
		t.Fatal("authoritative empty snapshot must reject every call")
	}
}
