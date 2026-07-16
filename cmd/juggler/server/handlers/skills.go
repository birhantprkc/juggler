//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"juggler/internal/userpaths"

	"github.com/gorilla/mux"
)

// Agent Skills are directories following the open Agent Skills standard
// (agentskills.io): each skill is a folder holding at minimum a SKILL.md
// (YAML frontmatter + markdown instructions), optionally with scripts/,
// references/, and assets/. Juggler discovers them across a fixed set of source
// roots, in two scopes:
//
//	<project>/.juggler/skills/<name>/SKILL.md   project + juggler (native)
//	<project>/.agents/skills/<name>/SKILL.md    project + agents  (cross-agent alias)
//	<config>/skills/<name>/SKILL.md             user + juggler    (native)
//	~/.agents/skills/<name>/SKILL.md            user + agents     (cross-agent alias)
//
// This handler is discovery + read only: it serves skill *metadata* (name +
// description of every skill, always cheap) and, on demand, one skill's SKILL.md
// body plus a listing of its directory. Bodies are never returned in the list —
// the model loads a body through the `skill` tool only when a task matches
// (progressive disclosure). Files under a skill (scripts/, references/) are read
// by the model through the ordinary read/execute tools, under normal approval,
// so this handler adds no new execution or file-access path.

// skillNamePattern is the spec-mandated skill name: lowercase letters/digits in
// hyphen-separated groups, so no leading, trailing, or doubled hyphen. Length is
// bounded separately (<= maxSkillNameLen). The name must also equal the skill's
// directory name.
var skillNamePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// maxSkillNameLen is the spec cap on a skill name.
const maxSkillNameLen = 64

// maxSkillFileListing bounds the per-skill file listing returned by the body
// endpoint, so a pathological skill directory can't produce an unbounded
// response (the listing is advisory — the model reads real files via read).
const maxSkillFileListing = 500

// SkillFrontmatter is the parsed YAML frontmatter of a SKILL.md. Only the spec's
// top-level scalar fields are interpreted; unknown keys and nested mappings
// (Claude-Code's when_to_use, a `metadata:` map, etc.) are preserved-and-ignored
// rather than rejected, so a skill authored for another agent still loads. Absence of a required field
// (description) surfaces as an Error on the owning Skill, never a silent drop.
type SkillFrontmatter struct {
	Name          string `json:"name,omitempty"`
	Description   string `json:"description,omitempty"`
	License       string `json:"license,omitempty"`
	Compatibility string `json:"compatibility,omitempty"`
	AllowedTools  string `json:"allowedTools,omitempty"` // surfaced read-only; NOT honored in v1 (see plan §4)
}

// Skill is one entry in the GET /api/skills response — metadata only, never the
// SKILL.md body. A directory that fails to parse or validate is still returned
// with Error set so the manager UI can show exactly why it is broken. A skill
// whose name is claimed by a higher-precedence root carries ShadowedBy (the
// winning "<scope>-<source>") but is still listed — never a silent drop.
type Skill struct {
	Name          string           `json:"name"`
	Description   string           `json:"description"`
	Scope         string           `json:"scope"`  // "user" | "project"
	Source        string           `json:"source"` // "juggler" | "agents"
	Path          string           `json:"path"`   // absolute on-disk skill directory
	Frontmatter   SkillFrontmatter `json:"frontmatter"`
	HasScripts    bool             `json:"hasScripts"`
	HasReferences bool             `json:"hasReferences"`
	ShadowedBy    string           `json:"shadowedBy,omitempty"`
	Error         string           `json:"error,omitempty"`
}

// SkillFile is one entry in a skill's directory listing (relative path + size),
// returned by the body endpoint so the tool result can tell the model what is
// available under references/, scripts/, assets/, etc.
type SkillFile struct {
	Path string `json:"path"` // forward-slash path relative to the skill directory
	Size int64  `json:"size"`
}

// SkillDetail is the GET /api/skills/{scope}/{source}/{name} response: the full
// SKILL.md body plus the directory listing. Metadata mirrors the list entry.
type SkillDetail struct {
	Name   string      `json:"name"`
	Scope  string      `json:"scope"`
	Source string      `json:"source"`
	Path   string      `json:"path"`
	Body   string      `json:"body"`
	Files  []SkillFile `json:"files"`
}

// skillRoot is one discovered source directory: a (scope, source) pair mapped to
// its on-disk skills directory. Roots are enumerated in precedence order (see
// roots), so the first occurrence of a name wins and later ones are shadowed.
type skillRoot struct {
	scope  string
	source string
	dir    string
}

// label is the "<scope>-<source>" identifier surfaced to the frontend (badge,
// shadowedBy origin, tool-result header).
func (r skillRoot) label() string { return r.scope + "-" + r.source }

// SkillsAPI discovers and serves Agent Skills. The project path is read through a
// provider func so a runtime project switch is reflected without reconstructing
// the handler (mirrors UserCommandsAPI / ConfigAPI).
type SkillsAPI struct {
	projectPathProvider func() string
}

// NewSkillsAPI creates a SkillsAPI. projectPathProvider returns the current
// project root ("" in no-project mode).
func NewSkillsAPI(projectPathProvider func() string) *SkillsAPI {
	return &SkillsAPI{projectPathProvider: projectPathProvider}
}

// roots returns the skill source roots in precedence order (first wins on a name
// collision): project-juggler, project-agents, user-juggler, user-agents.
// Project roots are omitted in no-project mode. A root directory that doesn't
// exist is harmless — discovery simply finds nothing there.
func (api *SkillsAPI) roots() []skillRoot {
	var roots []skillRoot
	if project := api.projectPathProvider(); project != "" {
		roots = append(roots,
			skillRoot{scope: "project", source: "juggler", dir: filepath.Join(project, ".juggler", "skills")},
			skillRoot{scope: "project", source: "agents", dir: filepath.Join(project, ".agents", "skills")},
		)
	}
	roots = append(roots, skillRoot{scope: "user", source: "juggler", dir: filepath.Join(userpaths.ConfigDir(), "skills")})
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, skillRoot{scope: "user", source: "agents", dir: filepath.Join(home, ".agents", "skills")})
	}
	return roots
}

// HandleList returns every discovered skill across all roots, with shadowed and
// error flags set (never a silent drop), sorted by name then scope then source
// for deterministic, cache-stable output. Bodies are never included.
func (api *SkillsAPI) HandleList(w http.ResponseWriter, r *http.Request) {
	skills := []Skill{}
	winners := map[string]skillRoot{} // skill name -> highest-precedence root that provides it
	for _, root := range api.roots() {
		for _, skill := range discoverSkills(root) {
			// Only well-formed skills participate in shadowing: a broken skill
			// neither wins a name nor is marked "shadowed" (its Error already
			// explains why it is unusable).
			if skill.Error == "" {
				if win, ok := winners[skill.Name]; ok {
					skill.ShadowedBy = win.label()
				} else {
					winners[skill.Name] = root
				}
			}
			skills = append(skills, skill)
		}
	}
	sort.Slice(skills, func(i, j int) bool {
		if skills[i].Name != skills[j].Name {
			return skills[i].Name < skills[j].Name
		}
		if skills[i].Scope != skills[j].Scope {
			return skills[i].Scope < skills[j].Scope
		}
		return skills[i].Source < skills[j].Source
	})
	WriteJSON(w, r, 0, skills)
}

// HandleGet returns one skill's SKILL.md body and directory listing for
// {scope}/{source}/{name}. The name must match the spec pattern (which excludes
// path separators and dots), and the resolved directory must stay inside its
// root — so directory traversal is impossible by construction and re-checked
// defensively. A malformed frontmatter still returns its body (best effort), so
// the manager preview and the tool can show what the file contains.
func (api *SkillsAPI) HandleGet(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	scope, source, name := vars["scope"], vars["source"], vars["name"]

	if !validSkillName(name) {
		writeError(w, r, http.StatusBadRequest, "invalid skill name")
		return
	}
	rootDir, ok := api.resolveRootDir(scope, source)
	if !ok {
		writeError(w, r, http.StatusBadRequest, fmt.Sprintf("unknown or unavailable source %q/%q", scope, source))
		return
	}
	dir := filepath.Join(rootDir, name)
	if !pathWithin(rootDir, dir) {
		writeError(w, r, http.StatusBadRequest, "invalid skill path")
		return
	}
	data, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		writeError(w, r, http.StatusNotFound, fmt.Sprintf("skill %q not found in %s/%s", name, scope, source))
		return
	}
	_, body, _ := parseSkillFile(data) // body is served even when frontmatter is malformed
	WriteJSON(w, r, 0, SkillDetail{
		Name:   name,
		Scope:  scope,
		Source: source,
		Path:   dir,
		Body:   body,
		Files:  listSkillFiles(dir),
	})
}

// resolveRootDir maps a (scope, source) pair to its skills directory, honoring
// no-project mode (project scopes are absent from roots() then). Returns
// ok=false for an unknown or unavailable pair.
func (api *SkillsAPI) resolveRootDir(scope, source string) (string, bool) {
	for _, root := range api.roots() {
		if root.scope == scope && root.source == source {
			return root.dir, true
		}
	}
	return "", false
}

// discoverSkills scans one root directory for skill subdirectories (each holding
// a SKILL.md). A missing/unreadable root yields nothing. Every candidate is
// returned; parse/validation failures carry Error rather than being dropped.
func discoverSkills(root skillRoot) []Skill {
	entries, err := os.ReadDir(root.dir)
	if err != nil {
		return nil // absent or unreadable — no skills here
	}
	var out []Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dir := filepath.Join(root.dir, name)
		if _, err := os.Stat(filepath.Join(dir, "SKILL.md")); err != nil {
			continue // a plain directory, not a skill — silently ignored
		}
		skill := Skill{
			Name:          name,
			Scope:         root.scope,
			Source:        root.source,
			Path:          dir,
			HasScripts:    dirExists(filepath.Join(dir, "scripts")),
			HasReferences: dirExists(filepath.Join(dir, "references")),
		}
		if !validSkillName(name) {
			skill.Error = "invalid skill name (lowercase letters, digits, and single hyphens; max 64 chars)"
			out = append(out, skill)
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		if err != nil {
			skill.Error = fmt.Sprintf("could not read SKILL.md: %v", err)
			out = append(out, skill)
			continue
		}
		fm, _, parseErr := parseSkillFile(data)
		skill.Frontmatter = fm
		skill.Description = fm.Description
		switch {
		case parseErr != nil:
			skill.Error = parseErr.Error()
		case strings.TrimSpace(fm.Description) == "":
			skill.Error = "missing required frontmatter field: description"
		case fm.Name != "" && fm.Name != name:
			skill.Error = fmt.Sprintf("frontmatter name %q does not match directory name %q", fm.Name, name)
		}
		out = append(out, skill)
	}
	return out
}

// parseSkillFile splits a SKILL.md into frontmatter and body using the shared
// frontmatter splitter/scanner, mapping the spec's scalar keys onto
// SkillFrontmatter. Unknown keys are ignored (preserve-and-ignore), so a skill
// carrying another agent's non-spec fields still parses.
func parseSkillFile(data []byte) (SkillFrontmatter, string, error) {
	var fm SkillFrontmatter
	fmLines, body, err := splitFrontmatter(data)
	if err != nil {
		return fm, body, err
	}
	scanFrontmatterFields(fmLines, func(key, value string) {
		switch key {
		case "name":
			fm.Name = value
		case "description":
			fm.Description = value
		case "license":
			fm.License = value
		case "compatibility":
			fm.Compatibility = value
		case "allowed-tools", "allowedTools":
			fm.AllowedTools = value
		}
	})
	return fm, body, nil
}

// listSkillFiles walks a skill directory and returns every regular file as a
// forward-slash path relative to the directory, with its size, sorted for
// deterministic output and capped at maxSkillFileListing (the walk stops at the
// cap, so a pathological directory isn't traversed in full — WalkDir's lexical
// order keeps the retained subset deterministic). Errors mid-walk are tolerated
// (best-effort listing); the model reads real files via the read tool.
func listSkillFiles(dir string) []SkillFile {
	files := []SkillFile{}
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if len(files) >= maxSkillFileListing {
			return fs.SkipAll
		}
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // skip unreadable entries, keep walking
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return nil
		}
		info, infoErr := d.Info()
		size := int64(0)
		if infoErr == nil {
			size = info.Size()
		}
		files = append(files, SkillFile{Path: filepath.ToSlash(rel), Size: size})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files
}

// validSkillName reports whether name is a spec-valid skill name (pattern +
// length bound). Because it forbids '/', '.', and '\', a valid name can never
// escape its root directory.
func validSkillName(name string) bool {
	return len(name) <= maxSkillNameLen && skillNamePattern.MatchString(name)
}

// pathWithin reports whether child resolves inside root (defense-in-depth
// against traversal, though validSkillName already precludes it).
func pathWithin(root, child string) bool {
	rel, err := filepath.Rel(root, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// dirExists reports whether path exists and is a directory.
func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
