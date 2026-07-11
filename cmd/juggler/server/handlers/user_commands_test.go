//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gorilla/mux"
)

// newTestAPI builds a UserCommandsAPI whose user scope points at a temp dir
// (via JUGGLER_CONFIG_DIR) and whose project scope points at projectDir.
func newTestAPI(t *testing.T, projectDir string) *UserCommandsAPI {
	t.Helper()
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	return NewUserCommandsAPI(func() string { return projectDir })
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func listCommands(t *testing.T, api *UserCommandsAPI) []UserCommand {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/user-commands", nil)
	rec := httptest.NewRecorder()
	api.HandleList(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var cmds []UserCommand
	if err := json.Unmarshal(rec.Body.Bytes(), &cmds); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return cmds
}

func TestDiscoverValidCommand(t *testing.T) {
	project := t.TempDir()
	api := newTestAPI(t, project)
	writeFile(t, filepath.Join(project, ".juggler", "commands"), "review.md",
		"---\ndescription: Review a PR\nargsHint: <pr-number>\nrun: subthread\ngoal: PR review\n---\nReview PR $1.\n$ARGUMENTS\n")

	cmds := listCommands(t, api)
	if len(cmds) != 1 {
		t.Fatalf("got %d commands, want 1", len(cmds))
	}
	c := cmds[0]
	if c.Error != "" {
		t.Fatalf("unexpected error: %s", c.Error)
	}
	if c.Name != "review" || c.Scope != "project" {
		t.Errorf("name/scope = %q/%q", c.Name, c.Scope)
	}
	if c.Frontmatter.Description != "Review a PR" {
		t.Errorf("description = %q", c.Frontmatter.Description)
	}
	if c.Frontmatter.ArgsHint != "<pr-number>" {
		t.Errorf("argsHint = %q", c.Frontmatter.ArgsHint)
	}
	if c.Frontmatter.Run != "subthread" || c.Frontmatter.Goal != "PR review" {
		t.Errorf("run/goal = %q/%q", c.Frontmatter.Run, c.Frontmatter.Goal)
	}
	if c.Body != "Review PR $1.\n$ARGUMENTS\n" {
		t.Errorf("body = %q", c.Body)
	}
}

func TestDiscoverBothScopes(t *testing.T) {
	project := t.TempDir()
	api := newTestAPI(t, project)
	writeFile(t, api.UserCommandDir(), "standup.md", "---\ndescription: standup\n---\nhi\n")
	writeFile(t, api.ProjectCommandDir(), "review.md", "---\ndescription: review\n---\nhi\n")

	cmds := listCommands(t, api)
	if len(cmds) != 2 {
		t.Fatalf("got %d commands, want 2", len(cmds))
	}
	// Sorted by scope then name: project before user.
	if cmds[0].Scope != "project" || cmds[1].Scope != "user" {
		t.Errorf("scope order = %q, %q", cmds[0].Scope, cmds[1].Scope)
	}
}

func TestDiscoverMalformedReturnsError(t *testing.T) {
	project := t.TempDir()
	api := newTestAPI(t, project)
	dir := api.ProjectCommandDir()
	// Missing description.
	writeFile(t, dir, "no-desc.md", "---\nrun: send\n---\nbody\n")
	// No frontmatter at all.
	writeFile(t, dir, "no-fm.md", "just a body\n")
	// Unterminated frontmatter.
	writeFile(t, dir, "bad-fm.md", "---\ndescription: x\nbody with no close\n")

	cmds := listCommands(t, api)
	byName := map[string]UserCommand{}
	for _, c := range cmds {
		byName[c.Name] = c
	}
	for _, n := range []string{"no-desc", "no-fm", "bad-fm"} {
		if byName[n].Error == "" {
			t.Errorf("%s: expected error, got none", n)
		}
	}
}

func TestDiscoverInvalidName(t *testing.T) {
	project := t.TempDir()
	api := newTestAPI(t, project)
	writeFile(t, api.ProjectCommandDir(), "Bad_Name.md", "---\ndescription: x\n---\nbody\n")
	cmds := listCommands(t, api)
	if len(cmds) != 1 || cmds[0].Error == "" {
		t.Fatalf("expected one command flagged invalid, got %+v", cmds)
	}
}

func putCommand(t *testing.T, api *UserCommandsAPI, scope, name string, req UserCommandWriteRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(req)
	// Use a fixed valid target; the router-extracted vars are supplied via
	// SetURLVars so a name containing URL-invalid chars (spaces) still exercises
	// the handler's own validation rather than failing request construction.
	r := httptest.NewRequest(http.MethodPut, "/api/user-commands/x/x", bytes.NewReader(body))
	r = mux.SetURLVars(r, map[string]string{"scope": scope, "name": name})
	rec := httptest.NewRecorder()
	api.HandlePut(rec, r)
	return rec
}

func TestPutThenDiscover(t *testing.T) {
	project := t.TempDir()
	api := newTestAPI(t, project)
	rec := putCommand(t, api, "project", "deploy", UserCommandWriteRequest{
		Description: "Deploy the app",
		Run:         "send",
		Template:    "Deploy $1 to $2.",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body = %s", rec.Code, rec.Body.String())
	}
	cmds := listCommands(t, api)
	if len(cmds) != 1 || cmds[0].Name != "deploy" || cmds[0].Error != "" {
		t.Fatalf("discover after PUT: %+v", cmds)
	}
	if cmds[0].Body != "Deploy $1 to $2.\n" {
		t.Errorf("body = %q", cmds[0].Body)
	}
	if cmds[0].Frontmatter.Run != "send" {
		t.Errorf("run = %q", cmds[0].Frontmatter.Run)
	}
}

func TestPutValidationErrors(t *testing.T) {
	api := newTestAPI(t, t.TempDir())
	cases := []struct {
		name  string
		req   UserCommandWriteRequest
		field string
	}{
		{"Bad Name", UserCommandWriteRequest{Description: "d", Template: "t"}, "name"},
		{"good", UserCommandWriteRequest{Template: "t"}, "description"},
		{"good", UserCommandWriteRequest{Description: "d", Run: "bogus", Template: "t"}, "run"},
		{"good", UserCommandWriteRequest{Description: "d"}, "template"},
	}
	for _, tc := range cases {
		rec := putCommand(t, api, "project", tc.name, tc.req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: status = %d, want 400", tc.field, rec.Code)
			continue
		}
		var resp struct {
			Errors map[string]string `json:"errors"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, ok := resp.Errors[tc.field]; !ok {
			t.Errorf("expected field error %q, got %v", tc.field, resp.Errors)
		}
	}
}

func TestDeleteCommand(t *testing.T) {
	project := t.TempDir()
	api := newTestAPI(t, project)
	writeFile(t, api.ProjectCommandDir(), "gone.md", "---\ndescription: x\n---\nbody\n")

	r := httptest.NewRequest(http.MethodDelete, "/api/user-commands/project/gone", nil)
	r = mux.SetURLVars(r, map[string]string{"scope": "project", "name": "gone"})
	rec := httptest.NewRecorder()
	api.HandleDelete(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", rec.Code)
	}
	if cmds := listCommands(t, api); len(cmds) != 0 {
		t.Fatalf("want 0 commands after delete, got %d", len(cmds))
	}

	// Idempotent: deleting again still succeeds.
	rec2 := httptest.NewRecorder()
	api.HandleDelete(rec2, r)
	if rec2.Code != http.StatusOK {
		t.Errorf("second DELETE status = %d, want 200", rec2.Code)
	}
}

func TestNoProjectScopeUnavailable(t *testing.T) {
	api := newTestAPI(t, "") // no project
	if api.ProjectCommandDir() != "" {
		t.Errorf("ProjectCommandDir = %q, want empty", api.ProjectCommandDir())
	}
	rec := putCommand(t, api, "project", "x", UserCommandWriteRequest{Description: "d", Template: "t"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("PUT to unavailable project scope: status = %d, want 400", rec.Code)
	}
}

func TestRoundTripQuotedValue(t *testing.T) {
	project := t.TempDir()
	api := newTestAPI(t, project)
	// A value with a leading '#' would be a YAML comment if unquoted.
	putCommand(t, api, "project", "hashy", UserCommandWriteRequest{
		Description: "#1 helper",
		ArgsHint:    "  spaced  ",
		Template:    "body",
	})
	cmds := listCommands(t, api)
	if len(cmds) != 1 {
		t.Fatalf("got %d", len(cmds))
	}
	if cmds[0].Frontmatter.Description != "#1 helper" {
		t.Errorf("description round-trip = %q", cmds[0].Frontmatter.Description)
	}
	if cmds[0].Frontmatter.ArgsHint != "  spaced  " {
		t.Errorf("argsHint round-trip = %q", cmds[0].Frontmatter.ArgsHint)
	}
}
