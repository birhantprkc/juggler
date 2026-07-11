//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"juggler/internal/userpaths"

	"github.com/gorilla/mux"
)

// User-defined slash commands are declarative markdown files (YAML frontmatter +
// prompt-template body), one command per file, in two scopes:
//
//	~/.juggler/commands/*.md            user scope (all projects)
//	<project>/.juggler/commands/*.md    project scope (git-shareable)
//
// They are the no-code tier below extensions: a command is *data* interpreted by
// a single generic frontend CommandType. This handler discovers, serves, and
// writes them; the frontend synthesises a command class per definition.

// userCommandNamePattern is the allowed command name (= filename sans .md).
var userCommandNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// validRunModes are the execution modes a definition may declare.
var validRunModes = map[string]bool{"send": true, "draft": true, "subthread": true}

// UserCommandFrontmatter is the parsed YAML frontmatter of a command file. All
// fields are optional except description (required; its absence is surfaced as
// an Error on the owning UserCommand, never a silent drop).
type UserCommandFrontmatter struct {
	Description string `json:"description,omitempty"`
	ArgsHint    string `json:"argsHint,omitempty"`
	Run         string `json:"run,omitempty"`      // send (default) | draft | subthread
	Strategy    string `json:"strategy,omitempty"` // subthread only
	Model       string `json:"model,omitempty"`    // subthread only
	Icon        string `json:"icon,omitempty"`
	Goal        string `json:"goal,omitempty"` // subthread only — thread goal label
}

// UserCommand is one entry in the GET /api/user-commands response. A file that
// fails to parse or validate is still returned with Error set so the manager UI
// can show exactly why it is broken — never a silent drop.
type UserCommand struct {
	Name        string                 `json:"name"`
	Scope       string                 `json:"scope"` // "user" | "project"
	Path        string                 `json:"path"`  // absolute on-disk path
	Frontmatter UserCommandFrontmatter `json:"frontmatter"`
	Body        string                 `json:"body"`
	Error       string                 `json:"error,omitempty"`
}

// UserCommandWriteRequest is the JSON body of a PUT. The server owns markdown
// serialization so the editor dialog and the define_command tool share one
// format and one validation path.
type UserCommandWriteRequest struct {
	Description string `json:"description"`
	ArgsHint    string `json:"argsHint"`
	Run         string `json:"run"`
	Strategy    string `json:"strategy"`
	Model       string `json:"model"`
	Icon        string `json:"icon"`
	Goal        string `json:"goal"`
	Template    string `json:"template"` // the prompt-template body
}

// UserCommandsAPI discovers, serves, and writes user-defined slash commands. The
// project path is read through a provider func so a runtime project switch is
// reflected without reconstructing the handler (mirrors ConfigAPI).
type UserCommandsAPI struct {
	projectPathProvider func() string
}

// NewUserCommandsAPI creates a UserCommandsAPI. projectPathProvider returns the
// current project root ("" in no-project mode).
func NewUserCommandsAPI(projectPathProvider func() string) *UserCommandsAPI {
	return &UserCommandsAPI{projectPathProvider: projectPathProvider}
}

// UserCommandDir is the user-scope command directory (~/.juggler/commands).
func (api *UserCommandsAPI) UserCommandDir() string {
	return filepath.Join(userpaths.ConfigDir(), "commands")
}

// ProjectCommandDir is the project-scope command directory
// (<project>/.juggler/commands), or "" in no-project mode.
func (api *UserCommandsAPI) ProjectCommandDir() string {
	projectPath := api.projectPathProvider()
	if projectPath == "" {
		return ""
	}
	return filepath.Join(projectPath, ".juggler", "commands")
}

// scopeDir maps a scope name to its command directory, or "" if unknown/absent.
func (api *UserCommandsAPI) scopeDir(scope string) string {
	switch scope {
	case "user":
		return api.UserCommandDir()
	case "project":
		return api.ProjectCommandDir()
	default:
		return ""
	}
}

// resolveTarget extracts the {scope}/{name} route vars and resolves the scope's
// command directory, writing a 400 (and returning ok=false) when the scope is
// unknown or unavailable (project scope in no-project mode).
func (api *UserCommandsAPI) resolveTarget(w http.ResponseWriter, r *http.Request) (scope, name, dir string, ok bool) {
	scope = mux.Vars(r)["scope"]
	name = mux.Vars(r)["name"]
	dir = api.scopeDir(scope)
	if dir == "" {
		writeError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown or unavailable scope %q", scope))
		return "", "", "", false
	}
	return scope, name, dir, true
}

// HandleList returns every discovered command across both scopes, sorted by
// scope then name for deterministic output. Malformed files are returned with
// Error set rather than dropped.
func (api *UserCommandsAPI) HandleList(w http.ResponseWriter, r *http.Request) {
	commands := []UserCommand{}
	commands = append(commands, discoverCommands(api.UserCommandDir(), "user")...)
	commands = append(commands, discoverCommands(api.ProjectCommandDir(), "project")...)
	sort.Slice(commands, func(i, j int) bool {
		if commands[i].Scope != commands[j].Scope {
			return commands[i].Scope < commands[j].Scope
		}
		return commands[i].Name < commands[j].Name
	})
	writeJSON(w, r, 0, commands)
}

// HandlePut creates or overwrites a command file for {scope}/{name}. It
// validates the name charset, run mode, and required fields, returning
// structured field errors ({"errors": {field: message}}) with 400 for inline
// display in the editor. Parent directories are created on demand.
func (api *UserCommandsAPI) HandlePut(w http.ResponseWriter, r *http.Request) {
	scope, name, dir, ok := api.resolveTarget(w, r)
	if !ok {
		return
	}

	var req UserCommandWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if fieldErrors := validateWriteRequest(name, req); len(fieldErrors) > 0 {
		writeJSON(w, r, http.StatusBadRequest, map[string]any{"errors": fieldErrors})
		return
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeError(w, r, http.StatusInternalServerError, fmt.Sprintf("could not create commands dir: %v", err))
		return
	}
	path := filepath.Join(dir, name+".md")
	if err := os.WriteFile(path, []byte(serializeCommand(req)), 0o644); err != nil {
		writeError(w, r, http.StatusInternalServerError, fmt.Sprintf("could not write command: %v", err))
		return
	}
	writeJSON(w, r, 0, UserCommand{
		Name:        name,
		Scope:       scope,
		Path:        path,
		Frontmatter: frontmatterOf(req),
		Body:        req.Template,
	})
}

// HandleDelete removes a command file for {scope}/{name}. A missing file is a
// no-op success (idempotent delete).
func (api *UserCommandsAPI) HandleDelete(w http.ResponseWriter, r *http.Request) {
	_, name, dir, ok := api.resolveTarget(w, r)
	if !ok {
		return
	}
	if !userCommandNamePattern.MatchString(name) {
		writeError(w, r, http.StatusBadRequest, "invalid command name")
		return
	}
	path := filepath.Join(dir, name+".md")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		writeError(w, r, http.StatusInternalServerError, fmt.Sprintf("could not delete command: %v", err))
		return
	}
	writeJSON(w, r, 0, map[string]bool{"deleted": true})
}

// validateWriteRequest returns a field→message map of validation errors (empty
// when the request is valid). Collisions with built-in/extension command ids are
// deliberately NOT checked here: built-ins are defined in frontend JS the server
// cannot enumerate, so a colliding definition still writes and is flagged at
// registry load time (surfaced in the manager UI).
func validateWriteRequest(name string, req UserCommandWriteRequest) map[string]string {
	errs := map[string]string{}
	if !userCommandNamePattern.MatchString(name) {
		errs["name"] = "name must be lowercase, start with a letter, and use only letters, digits, and hyphens"
	}
	if strings.TrimSpace(req.Description) == "" {
		errs["description"] = "description is required"
	}
	if req.Run != "" && !validRunModes[req.Run] {
		errs["run"] = `run must be one of "send", "draft", or "subthread"`
	}
	if strings.TrimSpace(req.Template) == "" {
		errs["template"] = "template is required"
	}
	return errs
}

// frontmatterOf projects a write request onto the frontmatter shape returned by
// discovery, so a PUT response matches what a subsequent GET would report.
func frontmatterOf(req UserCommandWriteRequest) UserCommandFrontmatter {
	return UserCommandFrontmatter{
		Description: req.Description,
		ArgsHint:    req.ArgsHint,
		Run:         req.Run,
		Strategy:    req.Strategy,
		Model:       req.Model,
		Icon:        req.Icon,
		Goal:        req.Goal,
	}
}

// serializeCommand renders a write request as a markdown file: a YAML
// frontmatter block (only non-empty fields) followed by the template body. The
// output round-trips through parseCommandFile.
func serializeCommand(req UserCommandWriteRequest) string {
	var b strings.Builder
	b.WriteString("---\n")
	writeField(&b, "description", req.Description)
	writeField(&b, "argsHint", req.ArgsHint)
	writeField(&b, "run", req.Run)
	writeField(&b, "strategy", req.Strategy)
	writeField(&b, "model", req.Model)
	writeField(&b, "icon", req.Icon)
	writeField(&b, "goal", req.Goal)
	b.WriteString("---\n")
	b.WriteString(req.Template)
	if !strings.HasSuffix(req.Template, "\n") {
		b.WriteString("\n")
	}
	return b.String()
}

// writeField emits one `key: value` frontmatter line when value is non-empty,
// quoting values whose leading/trailing whitespace or reserved leading
// characters would otherwise not round-trip through the flat parser.
func writeField(b *strings.Builder, key, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	if needsQuoting(value) {
		value = `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	b.WriteString(key)
	b.WriteString(": ")
	b.WriteString(value)
	b.WriteString("\n")
}

// needsQuoting reports whether a scalar value must be quoted to survive a
// round-trip (leading/trailing whitespace, or a leading YAML-significant char).
func needsQuoting(v string) bool {
	if v != strings.TrimSpace(v) {
		return true
	}
	if v == "" {
		return true
	}
	switch v[0] {
	case '"', '\'', '#', '&', '*', '!', '|', '>', '%', '@', '`', '[', '{':
		return true
	}
	return false
}

// discoverCommands scans one scope directory for *.md command files. A missing
// directory yields nothing. Each file is parsed; parse/validation failures are
// returned with Error set (never dropped).
func discoverCommands(dir, scope string) []UserCommand {
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil // absent or unreadable — no commands here
	}
	var out []UserCommand
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".md")
		path := filepath.Join(dir, entry.Name())
		cmd := UserCommand{Name: name, Scope: scope, Path: path}

		if !userCommandNamePattern.MatchString(name) {
			cmd.Error = "invalid command name (must be lowercase letters, digits, and hyphens, starting with a letter)"
			out = append(out, cmd)
			continue
		}

		data, err := os.ReadFile(path)
		if err != nil {
			cmd.Error = fmt.Sprintf("could not read file: %v", err)
			out = append(out, cmd)
			continue
		}
		fm, body, err := parseCommandFile(data)
		cmd.Frontmatter = fm
		cmd.Body = body
		if err != nil {
			cmd.Error = err.Error()
		} else if strings.TrimSpace(fm.Description) == "" {
			cmd.Error = "missing required frontmatter field: description"
		}
		out = append(out, cmd)
	}
	return out
}

// parseCommandFile splits a command file into its frontmatter and body. The
// frontmatter is a flat `key: value` block delimited by `---` lines; the body is
// everything after the closing delimiter. The parser is deliberately flat (no
// nested YAML) — the schema is a handful of scalar fields — which keeps it
// dependency-free and tolerant of the Claude-Code `.claude/commands` format on
// import (unknown keys are ignored; `argument-hint` maps to argsHint).
func parseCommandFile(data []byte) (UserCommandFrontmatter, string, error) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	var fm UserCommandFrontmatter

	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimRight(lines[0], " \t") != "---" {
		return fm, strings.TrimLeft(text, "\n"), fmt.Errorf("missing YAML frontmatter (file must begin with a --- line)")
	}
	closeIdx := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimRight(lines[i], " \t") == "---" {
			closeIdx = i
			break
		}
	}
	if closeIdx < 0 {
		return fm, "", fmt.Errorf("unterminated frontmatter (missing closing --- line)")
	}

	for _, line := range lines[1:closeIdx] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		value := unquoteScalar(strings.TrimSpace(line[colon+1:]))
		assignFrontmatterField(&fm, key, value)
	}

	body := strings.Join(lines[closeIdx+1:], "\n")
	body = strings.TrimPrefix(body, "\n")
	return fm, body, nil
}

// assignFrontmatterField maps one frontmatter key to its struct field. Unknown
// keys are ignored; `argument-hint` is accepted as an alias of argsHint for
// Claude-Code import compatibility.
func assignFrontmatterField(fm *UserCommandFrontmatter, key, value string) {
	switch key {
	case "description":
		fm.Description = value
	case "argsHint", "argument-hint":
		fm.ArgsHint = value
	case "run":
		fm.Run = value
	case "strategy":
		fm.Strategy = value
	case "model":
		fm.Model = value
	case "icon":
		fm.Icon = value
	case "goal":
		fm.Goal = value
	}
}

// unquoteScalar strips a single matching pair of surrounding quotes and unescapes
// \" inside double quotes. Bare values are returned unchanged.
func unquoteScalar(v string) string {
	if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
		return strings.ReplaceAll(v[1:len(v)-1], `\"`, `"`)
	}
	if len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'' {
		return v[1 : len(v)-1]
	}
	return v
}
