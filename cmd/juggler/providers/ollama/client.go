//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import (
	"juggler/cmd/juggler/providers/openaibase"
)

// DefaultHost is the URL used when no explicit host is configured.
const DefaultHost = "http://localhost:11434"

// HostCredKey is the credentials.json field where the user-configured Ollama
// daemon URL lives. Set via the settings panel; read by the shared LocalHost.
const HostCredKey = "ollama_host"

// daemon describes the local Ollama server as a keyless, host-configurable
// OpenAI-compatible endpoint. The shared helper supplies host resolution, URL
// normalisation, the /v1 base URL, and the health-probe detector.
var daemon = openaibase.LocalHost{
	CredKey:     HostCredKey,
	EnvVar:      "OLLAMA_HOST",
	DefaultHost: DefaultHost,
	HealthPath:  "/api/tags",
}

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:            "ollama",
		DisplayName:     "Ollama (local)",
		Description:     "Runs models locally via an Ollama daemon. The model list below mirrors whatever you have pulled (`ollama pull <name>`). Point at a non-default daemon (LAN, remote workstation) by setting the host below; otherwise defaults to http://localhost:11434.",
		AutoDetect:      daemon.AutoDetect(),
		ContextWindows:  ModelContextWindows,
		DisplayProvider: "Ollama",
		ContextWindowFn: getContextWindowInfo,
		BaseURLFunc:     daemon.BaseURLFunc(),
		APIKeyDefault:   "ollama", // placeholder so the OpenAI SDK accepts the request
	})
}

func getContextWindowInfo(modelID string) (int, int) {
	return GetContextWindow(modelID), DefaultMaxOutputTokens
}
