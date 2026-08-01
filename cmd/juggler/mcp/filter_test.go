//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

import (
	"reflect"
	"testing"
)

func TestAllowsTool(t *testing.T) {
	tests := []struct {
		name   string
		filter *ToolFilter
		tool   string
		want   bool
	}{
		{"nil filter allows all", nil, "anything", true},
		{"empty filter allows all", &ToolFilter{}, "anything", true},
		{"allowlist hit", &ToolFilter{Allow: []string{"recall", "retain"}}, "recall", true},
		{"allowlist miss", &ToolFilter{Allow: []string{"recall", "retain"}}, "delete_bank", false},
		{"deny only removes", &ToolFilter{Deny: []string{"delete_bank"}}, "delete_bank", false},
		{"deny only passes others", &ToolFilter{Deny: []string{"delete_bank"}}, "recall", true},
		{"deny subtracts from allow", &ToolFilter{Allow: []string{"recall", "retain"}, Deny: []string{"retain"}}, "retain", false},
		{"allow then deny lets others through", &ToolFilter{Allow: []string{"recall", "retain"}, Deny: []string{"retain"}}, "recall", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.filter.allowsTool(tt.tool); got != tt.want {
				t.Errorf("allowsTool(%q) = %v, want %v", tt.tool, got, tt.want)
			}
		})
	}
}

func TestApplyServerConfigFilters(t *testing.T) {
	tools := []ToolInfo{
		{Server: "s", Name: "recall"},
		{Server: "s", Name: "delete_bank"},
		{Server: "s", Name: "retain"},
	}
	cfg := ServerConfig{Tools: &ToolFilter{Allow: []string{"recall", "retain"}}}
	got := applyServerConfig(cfg, tools)
	if len(got) != 2 || got[0].Name != "recall" || got[1].Name != "retain" {
		t.Fatalf("want [recall retain], got %+v", got)
	}
	// Input slice must be untouched.
	if len(tools) != 3 {
		t.Errorf("input slice was mutated: %+v", tools)
	}
}

func TestApplyServerConfigStripsDefaultArgKeys(t *testing.T) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"msg":     map[string]any{"type": "string"},
			"bank_id": map[string]any{"type": "string"},
		},
		"required": []any{"msg", "bank_id"},
	}
	tools := []ToolInfo{{Server: "s", Name: "retain", InputSchema: schema, SchemaTokens: 999}}
	cfg := ServerConfig{DefaultArguments: map[string]any{"bank_id": "general"}}

	got := applyServerConfig(cfg, tools)
	if len(got) != 1 {
		t.Fatalf("want 1 tool, got %d", len(got))
	}
	out, ok := got[0].InputSchema.(map[string]any)
	if !ok {
		t.Fatalf("schema not a map: %T", got[0].InputSchema)
	}
	props := out["properties"].(map[string]any)
	if _, present := props["bank_id"]; present {
		t.Errorf("bank_id should be stripped from properties: %+v", props)
	}
	if _, present := props["msg"]; !present {
		t.Errorf("msg should remain in properties: %+v", props)
	}
	req := out["required"].([]any)
	if len(req) != 1 || req[0] != "msg" {
		t.Errorf("required should be [msg], got %+v", req)
	}
	if got[0].SchemaTokens == 999 {
		t.Errorf("schema tokens should be recomputed after stripping")
	}

	// The original schema must be untouched (deep-copy on write).
	if _, present := schema["properties"].(map[string]any)["bank_id"]; !present {
		t.Errorf("original schema was mutated")
	}
	if len(schema["required"].([]any)) != 2 {
		t.Errorf("original required was mutated")
	}
}

func TestStripSchemaKeys(t *testing.T) {
	t.Run("non-map schema returned unchanged", func(t *testing.T) {
		if got := stripSchemaKeys("not a schema", []string{"x"}); got != "not a schema" {
			t.Errorf("got %v", got)
		}
	})
	t.Run("key absent returns same reference", func(t *testing.T) {
		m := map[string]any{"type": "object", "properties": map[string]any{"a": map[string]any{}}}
		got := stripSchemaKeys(m, []string{"nope"})
		if !reflect.DeepEqual(got, m) {
			t.Errorf("expected unchanged schema")
		}
	})
	t.Run("missing properties and required tolerated", func(t *testing.T) {
		m := map[string]any{"type": "object"}
		got := stripSchemaKeys(m, []string{"x"})
		if !reflect.DeepEqual(got, m) {
			t.Errorf("expected unchanged, got %+v", got)
		}
	})
}

func TestMergeDefaultArgs(t *testing.T) {
	t.Run("config wins over model", func(t *testing.T) {
		got := mergeDefaultArgs(map[string]any{"bank_id": "general"}, map[string]any{"bank_id": "model", "msg": "hi"})
		if got["bank_id"] != "general" || got["msg"] != "hi" {
			t.Errorf("config should win: %+v", got)
		}
	})
	t.Run("no defaults returns args unchanged", func(t *testing.T) {
		args := map[string]any{"msg": "hi"}
		if got := mergeDefaultArgs(nil, args); !reflect.DeepEqual(got, args) {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("nil args with defaults", func(t *testing.T) {
		got := mergeDefaultArgs(map[string]any{"bank_id": "general"}, nil)
		if got["bank_id"] != "general" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("does not mutate inputs", func(t *testing.T) {
		defaults := map[string]any{"bank_id": "general"}
		args := map[string]any{"msg": "hi"}
		_ = mergeDefaultArgs(defaults, args)
		if len(args) != 1 || len(defaults) != 1 {
			t.Errorf("inputs mutated: args=%+v defaults=%+v", args, defaults)
		}
	})
}
