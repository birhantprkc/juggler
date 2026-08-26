package worker

import "strings"

const jugglerMCPToolPrefix = "mcp__juggler__"

// collectOfferedToolNames records the canonical names the provider may call.
// Keep canonicalWorkerToolName aligned with TOOL_ALIASES in
// web/js/services/tool-generator.js and Claude Code's Juggler MCP prefix.
func collectOfferedToolNames(tools []ToolDefinition) map[string]bool {
	names := make(map[string]bool, len(tools))
	for _, tool := range tools {
		if tool.Name != "" {
			names[canonicalWorkerToolName(tool.Name)] = true
		}
	}
	return names
}

func canonicalWorkerToolName(name string) string {
	for strings.HasPrefix(name, jugglerMCPToolPrefix) {
		name = strings.TrimPrefix(name, jugglerMCPToolPrefix)
	}

	switch name {
	case "Bash":
		return "bash"
	case "Read":
		return "read"
	case "Write":
		return "write"
	case "Edit":
		return "edit"
	case "Grep":
		return "grep"
	case "Glob":
		return "glob"
	case "BatchRead":
		return "batch_read"
	case "BatchGrep":
		return "batch_grep"
	case "ExploreCode", "explore_code":
		return "query_code"
	default:
		return name
	}
}

func (r *run) toolWasOfferedThisTurn(name string) bool {
	// Direct tests and helper paths can process a response without making an LLM
	// request first. Only enforce admission when an authoritative snapshot exists.
	if r.t.offeredTools == nil {
		return true
	}
	return r.t.offeredTools[canonicalWorkerToolName(name)]
}
