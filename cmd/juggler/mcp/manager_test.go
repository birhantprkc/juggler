//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestMain lets the test binary double as a fake MCP server: when MCP_FAKE_MODE
// is set, it speaks the protocol over stdio (via the official SDK server, so the
// handshake is genuinely compatible) instead of running tests. The manager
// spawns os.Args[0] with this env set as its "server command".
func TestMain(m *testing.M) {
	switch os.Getenv("MCP_FAKE_MODE") {
	case "":
		os.Exit(m.Run())
	case "crash":
		os.Stderr.WriteString("fake server: boom\n")
		os.Exit(3)
	default:
		runFakeServer()
		os.Exit(0)
	}
}

// runFakeServer serves a tiny MCP server over stdio: an echo tool (write) and a
// peek tool annotated read-only.
func runFakeServer() {
	srv := mcp.NewServer(&mcp.Implementation{Name: "fake", Version: "9.9.9"}, nil)
	objSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"msg": map[string]any{"type": "string"}},
	}
	srv.AddTool(&mcp.Tool{Name: "echo", Description: "Echo the arguments back", InputSchema: objSchema}, echoHandler)
	srv.AddTool(&mcp.Tool{
		Name:        "peek",
		Description: "A read-only tool",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
		InputSchema: objSchema,
	}, echoHandler)
	_ = srv.Run(context.Background(), &mcp.StdioTransport{})
}

func echoHandler(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	text := "echo:" + req.Params.Name + ":" + string(req.Params.Arguments)
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil
}

// writeGlobalConfig points the manager's global config at a temp dir and writes
// one fake-server entry, returning nothing (project is "").
func writeGlobalConfig(t *testing.T, servers map[string]ServerConfig) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("JUGGLER_CONFIG_DIR", dir)
	data, err := json.MarshalIndent(Config{Servers: servers}, "", "  ")
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, mcpFileName), data, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
}

// waitFor polls until cond returns true or the deadline elapses.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}

func fakeServerConfig(mode string) ServerConfig {
	return ServerConfig{
		Command: os.Args[0],
		Env:     map[string]string{"MCP_FAKE_MODE": mode},
	}
}

func TestManagerDiscoveryAndCall(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{"fake": fakeServerConfig("serve")})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "fake" && s.Status == statusRunning {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("fake server never reached running: %+v", m.ListServers())
	}

	// Discovery: two tools, one read-only.
	tools := m.ListTools("fake")
	if len(tools) != 2 {
		t.Fatalf("want 2 tools, got %d: %+v", len(tools), tools)
	}
	var peek, echo *ToolInfo
	for i := range tools {
		switch tools[i].Name {
		case "peek":
			peek = &tools[i]
		case "echo":
			echo = &tools[i]
		}
	}
	if peek == nil || echo == nil {
		t.Fatalf("missing expected tools: %+v", tools)
	}
	if !peek.ReadOnly {
		t.Errorf("peek should be read-only")
	}
	if echo.ReadOnly {
		t.Errorf("echo should not be read-only")
	}
	if echo.SchemaTokens <= 0 {
		t.Errorf("echo should have a positive schema-token estimate")
	}

	// Server info surfaced.
	statuses := m.ListServers()
	if len(statuses) != 1 || statuses[0].ServerName != "fake" || statuses[0].ServerVer != "9.9.9" {
		t.Errorf("server info not surfaced: %+v", statuses)
	}

	// Call round-trips and echoes the arguments.
	res, err := m.CallTool(context.Background(), "fake", "echo", map[string]any{"msg": "hi"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected isError")
	}
	got := convertContent(res.Content)
	if len(got) != 1 || got[0]["type"] != "text" || !strings.Contains(got[0]["text"].(string), `"msg":"hi"`) {
		t.Fatalf("echo did not round-trip args: %+v", got)
	}

	// Stop transitions to stopped and drops tools.
	if err := m.Control("fake", "stop"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if !waitFor(t, 5*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "fake" {
				return s.Status == statusStopped && s.ToolCount == 0
			}
		}
		return false
	}) {
		t.Fatalf("fake server did not stop cleanly: %+v", m.ListServers())
	}
}

func TestManagerCrashMarksFailed(t *testing.T) {
	old := restartBackoff
	restartBackoff = 10 * time.Millisecond
	t.Cleanup(func() { restartBackoff = old })

	writeGlobalConfig(t, map[string]ServerConfig{"boom": fakeServerConfig("crash")})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "boom" && s.Status == statusFailed {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("crashing server never marked failed: %+v", m.ListServers())
	}

	// The captured stderr tail should be attached to the failure.
	for _, s := range m.ListServers() {
		if s.Name == "boom" && !strings.Contains(s.Error, "boom") {
			t.Errorf("failure should include stderr tail, got %q", s.Error)
		}
	}

	// A tool call against a failed server returns a clear error.
	if _, err := m.CallTool(context.Background(), "boom", "whatever", nil); err == nil {
		t.Errorf("expected error calling a failed server")
	}
}

// newHTTPFakeServer starts an httptest server speaking the streamable-HTTP MCP
// transport via the official SDK handler. If wantAuth is non-empty, requests
// must carry a matching Authorization header or they are rejected with 401.
func newHTTPFakeServer(t *testing.T, wantAuth string) *httptest.Server {
	t.Helper()
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		srv := mcp.NewServer(&mcp.Implementation{Name: "fake-http", Version: "8.8.8"}, nil)
		srv.AddTool(&mcp.Tool{
			Name:        "echo",
			Description: "Echo the arguments back",
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{"msg": map[string]any{"type": "string"}}},
		}, echoHandler)
		return srv
	}, nil)
	var h http.Handler = handler
	if wantAuth != "" {
		h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != wantAuth {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			handler.ServeHTTP(w, r)
		})
	}
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts
}

func TestManagerHTTPTransport(t *testing.T) {
	ts := newHTTPFakeServer(t, "")
	writeGlobalConfig(t, map[string]ServerConfig{
		"remote": {Transport: "http", URL: ts.URL},
	})

	m := NewManager()
	m.Start()
	m.Reconcile("")

	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "remote" && s.Status == statusRunning {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("http server never reached running: %+v", m.ListServers())
	}

	if tools := m.ListTools("remote"); len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("want one echo tool, got %+v", tools)
	}

	res, err := m.CallTool(context.Background(), "remote", "echo", map[string]any{"msg": "hi"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	got := convertContent(res.Content)
	if len(got) != 1 || !strings.Contains(got[0]["text"].(string), `"msg":"hi"`) {
		t.Fatalf("echo did not round-trip args: %+v", got)
	}

	// Close the session so the standalone SSE stream drains before httptest's
	// Close (registered earlier, so it runs after this) waits on connections.
	stopAndWait(t, m, "remote")
}

// stopAndWait stops a running server and blocks until it reports stopped, so any
// persistent HTTP/SSE connection is torn down before the test's httptest.Server
// is closed.
func stopAndWait(t *testing.T, m *Manager, name string) {
	t.Helper()
	if err := m.Control(name, "stop"); err != nil {
		t.Fatalf("stop %q: %v", name, err)
	}
	waitFor(t, 5*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == name {
				return s.Status == statusStopped
			}
		}
		return false
	})
}

func TestManagerHTTPHeaders(t *testing.T) {
	ts := newHTTPFakeServer(t, "Bearer sekret")

	// Without the header the connection is rejected.
	writeGlobalConfig(t, map[string]ServerConfig{"noauth": {Transport: "http", URL: ts.URL}})
	m := NewManager()
	m.Start()
	m.Reconcile("")
	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m.ListServers() {
			if s.Name == "noauth" && s.Status == statusFailed {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("unauthenticated http server should have failed: %+v", m.ListServers())
	}

	// With the header it connects and discovers tools.
	writeGlobalConfig(t, map[string]ServerConfig{
		"auth": {Transport: "http", URL: ts.URL, Headers: map[string]string{"Authorization": "Bearer sekret"}},
	})
	m2 := NewManager()
	m2.Start()
	m2.Reconcile("")
	if !waitFor(t, 15*time.Second, func() bool {
		for _, s := range m2.ListServers() {
			if s.Name == "auth" && s.Status == statusRunning {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("authenticated http server never reached running: %+v", m2.ListServers())
	}
	if tools := m2.ListTools("auth"); len(tools) != 1 {
		t.Fatalf("want one tool from authed server, got %+v", tools)
	}
	stopAndWait(t, m2, "auth")
}

func TestManagerTransportValidation(t *testing.T) {
	writeGlobalConfig(t, map[string]ServerConfig{
		"missing-url": {Transport: "http"},
		"bogus":       {Transport: "carrier-pigeon", URL: "http://example.invalid"},
	})
	m := NewManager()
	m.Start()
	m.Reconcile("")

	check := func(name, wantSubstr string) {
		if !waitFor(t, 5*time.Second, func() bool {
			for _, s := range m.ListServers() {
				if s.Name == name {
					return s.Status == statusFailed && strings.Contains(s.Error, wantSubstr)
				}
			}
			return false
		}) {
			t.Fatalf("server %q not failed with %q: %+v", name, wantSubstr, m.ListServers())
		}
	}
	check("missing-url", "no url configured")
	check("bogus", "unsupported transport")
}

func TestConfigMergeProjectOverridesGlobal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JUGGLER_CONFIG_DIR", dir)
	global := Config{Servers: map[string]ServerConfig{
		"a": {Command: "global-a"},
		"b": {Command: "global-b"},
	}}
	data, _ := json.MarshalIndent(global, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, mcpFileName), data, 0o644); err != nil {
		t.Fatal(err)
	}

	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".juggler"), 0o755); err != nil {
		t.Fatal(err)
	}
	projCfg := Config{Servers: map[string]ServerConfig{"b": {Command: "project-b"}}}
	pdata, _ := json.MarshalIndent(projCfg, "", "  ")
	if err := os.WriteFile(filepath.Join(project, ".juggler", mcpFileName), pdata, 0o644); err != nil {
		t.Fatal(err)
	}

	merged, err := loadMergedConfig(project)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if merged["a"].Command != "global-a" {
		t.Errorf("global-only entry lost: %+v", merged["a"])
	}
	if merged["b"].Command != "project-b" {
		t.Errorf("project entry should override global: %+v", merged["b"])
	}
}
