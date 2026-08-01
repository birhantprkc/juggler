//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

// This file holds the pure per-server policy transforms: the tool visibility
// filter (ToolFilter) and the fixed-argument merge/hide. They are deliberately
// free of manager state so they can be unit-tested directly and applied at a
// single choke point (where discovered tools are stored, and where a call is
// dispatched).

// allowsTool reports whether a raw MCP tool name passes this filter. A nil
// filter allows everything. A non-empty Allow is a strict allowlist; Deny then
// removes names from whatever survives.
func (f *ToolFilter) allowsTool(name string) bool {
	if f == nil {
		return true
	}
	if len(f.Allow) > 0 && !contains(f.Allow, name) {
		return false
	}
	if contains(f.Deny, name) {
		return false
	}
	return true
}

// contains reports whether list holds name (exact match).
func contains(list []string, name string) bool {
	for _, s := range list {
		if s == name {
			return true
		}
	}
	return false
}

// applyServerConfig returns the discovered tools that pass cfg's filter, each
// with its InputSchema stripped of any DefaultArguments keys (so the model never
// sees a parameter the configuration fixes). The input slice is never mutated:
// filtered-out tools are dropped and surviving tools' schemas are deep-copied
// before keys are removed. Schema-token estimates are recomputed for any tool
// whose schema changed.
func applyServerConfig(cfg ServerConfig, tools []ToolInfo) []ToolInfo {
	if len(tools) == 0 {
		return tools
	}
	keys := make([]string, 0, len(cfg.DefaultArguments))
	for k := range cfg.DefaultArguments {
		keys = append(keys, k)
	}
	out := make([]ToolInfo, 0, len(tools))
	for _, t := range tools {
		if !cfg.Tools.allowsTool(t.Name) {
			continue
		}
		if len(keys) > 0 {
			t.InputSchema = stripSchemaKeys(t.InputSchema, keys)
			t.SchemaTokens = estimateSchemaTokens(t.InputSchema)
		}
		out = append(out, t)
	}
	return out
}

// stripSchemaKeys returns a copy of a JSON-Schema object (map[string]any, as the
// MCP client decodes it) with the given keys removed from its "properties" and
// "required". Any other shape is returned unchanged. Only the containers that
// change are copied, so unrelated nodes stay shared. Returns the original value
// (same reference) when nothing would change, which lets the caller detect a
// no-op cheaply.
func stripSchemaKeys(schema any, keys []string) any {
	m, ok := schema.(map[string]any)
	if !ok || len(keys) == 0 {
		return schema
	}
	props, hasProps := m["properties"].(map[string]any)
	req, hasReq := m["required"].([]any)

	// Determine whether anything actually changes before copying.
	changed := false
	if hasProps {
		for _, k := range keys {
			if _, present := props[k]; present {
				changed = true
				break
			}
		}
	}
	if !changed && hasReq {
		for _, r := range req {
			if s, isStr := r.(string); isStr && contains(keys, s) {
				changed = true
				break
			}
		}
	}
	if !changed {
		return schema
	}

	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	if hasProps {
		np := make(map[string]any, len(props))
		for k, v := range props {
			if contains(keys, k) {
				continue
			}
			np[k] = v
		}
		out["properties"] = np
	}
	if hasReq {
		nr := make([]any, 0, len(req))
		for _, r := range req {
			if s, isStr := r.(string); isStr && contains(keys, s) {
				continue
			}
			nr = append(nr, r)
		}
		out["required"] = nr
	}
	return out
}

// mergeDefaultArgs overlays a server's configured default arguments onto the
// arguments the model supplied. The config value wins on key collisions. Returns
// a new map (never mutates either input); returns args unchanged when there are
// no defaults.
func mergeDefaultArgs(defaults, args map[string]any) map[string]any {
	if len(defaults) == 0 {
		return args
	}
	out := make(map[string]any, len(args)+len(defaults))
	for k, v := range args {
		out[k] = v
	}
	for k, v := range defaults {
		out[k] = v // config wins
	}
	return out
}
