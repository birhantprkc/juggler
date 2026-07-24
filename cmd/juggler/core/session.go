//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
)

// BinnedConvInfo describes a conversation that lives in .juggler/trash/.
// Sent over the wire to populate the Bin modal. The bin is a permanent holding
// area — items stay until the user restores them or empties the bin — so there
// is no expiry/binned-at timestamp to track.
type BinnedConvInfo struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	LastModifiedAt string `json:"lastModifiedAt"` // ISO 8601, the last time the conversation was actually edited (see lastActivityTime), not when it was binned
}

// ============================================================================
// Session Types
// ============================================================================

// RuntimeInfo contains environment info injected at runtime (not persisted)
type RuntimeInfo struct {
	ProjectPath string `json:"projectPath"`
	Platform    string `json:"platform"`
	Home        string `json:"home"`
}

// GetRuntimeInfo returns current runtime environment info
func GetRuntimeInfo(projectPath string) RuntimeInfo {
	home, _ := os.UserHomeDir()
	return RuntimeInfo{
		ProjectPath: projectPath,
		Platform:    runtime.GOOS,
		Home:        home,
	}
}

// WindowState is the native-window geometry for this project's window. It is a
// session global (persisted in .juggler/session.json) rather than a single
// machine-global file: every juggler process opens exactly one project (the
// per-project instance lock guarantees one live window per project), so keying
// geometry by project gives each window its own slot with no cross-process
// write race — and reopening a project restores its window where you left it.
// Process-local geometry; deliberately NOT part of Metadata, so it is never
// sent to viewers or surfaced as a frontend flag.
type WindowState struct {
	X          int  `json:"x"`
	Y          int  `json:"y"`
	Width      int  `json:"width"`
	Height     int  `json:"height"`
	HasPos     bool `json:"hasPos"`
	Maximised  bool `json:"maximised"`
	Fullscreen bool `json:"fullscreen"`
}

// Session represents the folder state with multiple conversations.
// There is exactly one session per folder.
//
// Conversation human-readable names are not persisted in this manifest:
// the on-disk folder name (.juggler/<sanitized-name>--<id>/) is the source of
// truth, parsed by ScanConvDirs at load time.
type Session struct {
	Version              int               `json:"version"`               // Schema version
	ConversationOrder    []string          `json:"conversationOrder"`     // Ordered list of conversation IDs (for tab ordering)
	Conversations        []json.RawMessage `json:"-"`                     // In-memory only, not serialized to session.json
	ActiveConversationID string            `json:"activeConversationId"`  // Currently selected conversation tab (persisted for refresh)
	MessageHistory       []string          `json:"messageHistory"`        // Session-level history of raw user messages for input navigation
	Metadata             map[string]any    `json:"metadata,omitempty"`    // General-purpose key-value store for frontend flags
	WindowState          *WindowState      `json:"windowState,omitempty"` // Native-window geometry for this project (nil until first save)
}

// NewSession creates a new session with initial state
func NewSession() *Session {
	return &Session{
		Version:           5,
		ConversationOrder: []string{},
		Conversations:     []json.RawMessage{},
		MessageHistory:    []string{},
	}
}

// Clone returns a private copy of the session that the caller may read or
// mutate freely without ever touching the original. Every container the rest of
// the code mutates — the three slices, the metadata map, the WindowState
// pointer — is duplicated, so a snapshot handed out by
// SessionManager.GetSession can never race the actor goroutine that owns the
// live session. (RawMessage payloads and metadata values are shared by
// reference: both are only ever replaced wholesale, never mutated in place.)
func (s *Session) Clone() *Session {
	if s == nil {
		return nil
	}
	c := *s
	c.ConversationOrder = append([]string(nil), s.ConversationOrder...)
	c.Conversations = append([]json.RawMessage(nil), s.Conversations...)
	c.MessageHistory = append([]string(nil), s.MessageHistory...)
	if s.Metadata != nil {
		c.Metadata = make(map[string]any, len(s.Metadata))
		for k, v := range s.Metadata {
			c.Metadata[k] = v
		}
	}
	if s.WindowState != nil {
		ws := *s.WindowState
		c.WindowState = &ws
	}
	return &c
}

// SetConversations replaces the in-memory per-conversation metadata
// payload. ConversationOrder is owned by CreateConversation,
// ReorderConversations, Delete/Bin, and the on-load reconcile.
func (s *Session) SetConversations(conversations []json.RawMessage) {
	s.Conversations = conversations
}

// UpdateConversation updates a single conversation by ID
// Returns error if conversation not found
func (s *Session) UpdateConversation(convID string, updated json.RawMessage) error {
	for i, conv := range s.Conversations {
		var obj struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(conv, &obj); err != nil {
			continue
		}
		if obj.ID == convID {
			s.Conversations[i] = updated
			return nil
		}
	}
	return fmt.Errorf("conversation not found: %s", convID)
}

// Validate checks if the session is valid
func (s *Session) Validate() error {
	if s.Version != 5 {
		return fmt.Errorf("unsupported session version: %d (expected 5)", s.Version)
	}
	if s.ConversationOrder == nil {
		return fmt.Errorf("session must have conversationOrder array (can be empty)")
	}

	return nil
}

// --- V5 Schema Structs (Yjs CRDT Support) ---

// ModelConfig represents LLM provider and model configuration
type ModelConfig struct {
	Provider string `json:"provider"` // e.g., "anthropic", "gemini", "openai"
	Model    string `json:"model"`    // Model ID
}

// PermissionRule represents a single auto-approval rule. The framework treats
// `Kind` and `Value` opaquely; each context-item plugin interprets its own
// rules. See web/js/model/message-thread-permissions.js for the contract.
type PermissionRule struct {
	ID       string      `json:"id"`
	ItemType string      `json:"itemType"`
	Kind     string      `json:"kind"`
	Value    interface{} `json:"value"`
	Scope    string      `json:"scope,omitempty"`
	Enabled  bool        `json:"enabled"`
}

// BranchPoint represents the branch origin for branched conversations
type BranchPoint struct {
	ParentConvID string `json:"parentConvId"` // Parent conversation ID
	BranchOpID   string `json:"branchOpId"`   // Operation ID where branch occurred
}

// Conversation represents a conversation using Yjs CRDT.
type Conversation struct {
	ID              string       `json:"id"`              // Conversation ID
	Name            string       `json:"name"`            // Display name
	Created         string       `json:"created"`         // Creation timestamp (ISO 8601)
	ModelConfig     *ModelConfig `json:"modelConfig"`     // LLM configuration
	CurrentStrategy string       `json:"currentStrategy"` // Active strategy ID

	// Yjs CRDT state (binary, base64-encoded when marshaled to JSON)
	YjsState    []byte `json:"yjsState"`    // Full Yjs document state
	StateVector []byte `json:"stateVector"` // Yjs state vector for sync

	// UI state and metadata (not in Yjs doc)
	PermissionRules []PermissionRule `json:"permissionRules,omitempty"` // Generic permission rules
	AllowedPaths    []string         `json:"allowedPaths,omitempty"`    // Allowed filesystem roots
	Status          string           `json:"status"`                    // Status: "active", "archived", etc.
	BranchPoint     *BranchPoint     `json:"branchPoint,omitempty"`     // Branch origin (if branched)
}

// Common errors
var (
	ErrSessionNotFound      = fmt.Errorf("session not found")
	ErrConversationNotFound = fmt.Errorf("conversation not found")
	ErrNameCollision        = fmt.Errorf("conversation name already in use")
	ErrInvalidName          = fmt.Errorf("conversation name is invalid")
	ErrInvalidConvID        = fmt.Errorf("invalid conversation id")
	ErrConvIDExists         = fmt.Errorf("conversation id already exists")
)

// ============================================================================
// FileSessionStore - file I/O methods (no goroutine, called from SessionManager)
// ============================================================================

// FileSessionStore implements session persistence using the filesystem.
// Session state is stored in {projectPath}/.juggler/:
//   - session.json: manifest (version, conversationOrder, activeConversationId, messageHistory, metadata)
//   - <name>--<id>/doc.yjs: binary Yjs conversation data
//   - <name>--<id>/txns/<txnID>.json: per-conversation transaction blobs
//   - <name>--<id>/undo.json: per-conversation undo state (optional)
//
// The folder name carries the human-readable conversation name; renames
// rename the folder (atomic os.Rename). The id stays as the stable handle
// used everywhere in code.
//
// This struct has no goroutine of its own; all methods are called from
// SessionManager's actor goroutine, which provides serialized access.
// `index` mirrors the on-disk folder layout and is rebuilt on Load and
// mutated by Save/Delete/Rename.
type FileSessionStore struct {
	projectPath string
	index       *ConvDirIndex
	// binIndex mirrors the layout of .juggler/trash/ — conversation folders
	// that have been binned. Same shape as index; rebuilt on Load and mutated
	// by BinConversation/RestoreConversation.
	binIndex *ConvDirIndex
	// deletedIDs tracks conversations explicitly deleted this session.
	// ensureConvDir consults it to refuse recreating a folder that was just
	// deleted, which would otherwise create an orphan "Untitled--<id>" ghost
	// picked up by reconcileConversationOrder on the next session load.
	// Populated by DeleteConversation; all access is from the SessionManager
	// actor goroutine, so no mutex is needed.
	deletedIDs map[string]bool
}

// NewFileSessionStore creates a new file-based store
func NewFileSessionStore(projectPath string) (*FileSessionStore, error) {
	jugglerDir := filepath.Join(projectPath, ".juggler")
	if err := os.MkdirAll(jugglerDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create .juggler directory: %w", err)
	}

	// Remove legacy sessions directory if it exists
	sessionsDir := filepath.Join(jugglerDir, "sessions")
	if _, err := os.Stat(sessionsDir); err == nil {
		os.RemoveAll(sessionsDir)
	}

	return &FileSessionStore{
		projectPath: projectPath,
		index:       NewConvDirIndex(),
		binIndex:    NewConvDirIndex(),
		deletedIDs:  make(map[string]bool),
	}, nil
}

// ConvDir returns the absolute folder path for the conversation, or "" if
// the conversation is unknown.
func (fs *FileSessionStore) ConvDir(convID string) (string, bool) {
	if fs.index == nil {
		return "", false
	}
	dir, ok := fs.index.ByID[convID]
	return dir, ok
}

// ConvNames returns a snapshot of id → human name for every conversation
// folder currently on disk. Safe to expose over the wire.
func (fs *FileSessionStore) ConvNames() map[string]string {
	out := make(map[string]string, len(fs.index.Names))
	for id, name := range fs.index.Names {
		out[id] = name
	}
	return out
}

// docPath returns the doc.yjs path inside a conv folder.
func docPath(convDir string) string {
	return filepath.Join(convDir, "doc.yjs")
}

// CreateConversationFolder creates a conversation folder for requestedID, or
// allocates a fresh id when requestedID is empty. It picks a case-folded-unique
// folder name based on the requested display name (sanitized; empty falls back
// to "Untitled"; collisions get a " (copy N)" suffix), and creates the folder
// on disk. Returns the id, the canonical name actually used, and the folder
// path.
//
// This is the authoritative entry point for creating a new conversation:
// the on-disk folder name is the source of truth for the conversation's
// display name from the very first moment, with no "Untitled" stage and
// no follow-up rename. Subsequent worker saves go through ensureConvDir
// and find this folder by id, preserving the name.
func (fs *FileSessionStore) CreateConversationFolder(name, requestedID string) (string, string, string, error) {
	if fs.index == nil {
		fs.index = NewConvDirIndex()
	}
	sanitized := SanitizeName(name)
	if sanitized == "" {
		sanitized = "Untitled"
	}
	id := requestedID
	if id == "" {
		id = GenerateConvID()
	} else if !IsValidConvID(id) {
		return "", "", "", fmt.Errorf("%w: %q", ErrInvalidConvID, id)
	}
	if _, exists := fs.index.ByID[id]; exists {
		return "", "", "", fmt.Errorf("%w: %s", ErrConvIDExists, id)
	}
	// Collision-resolve against existing names. id is either freshly generated
	// or has just been checked absent from the index; uniqueName's excludeID is
	// defensive.
	finalName := fs.uniqueName(sanitized, id)
	dir := filepath.Join(fs.jugglerDir(), BuildDirName(finalName, id))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", "", fmt.Errorf("create conv dir: %w", err)
	}
	// Touch an empty doc.yjs so concurrent loaders in other viewers see a
	// zero-byte file rather than ENOENT. loadStateFromDisk treats an empty file
	// as a fresh doc, and the worker's first save overwrites it with the real
	// Yjs state. Without this, a viewer racing the create gets "conversation
	// state file not found" and the new tab fails to load.
	if err := os.WriteFile(docPath(dir), nil, 0o644); err != nil {
		return "", "", "", fmt.Errorf("touch doc.yjs: %w", err)
	}
	fs.index.ByID[id] = dir
	fs.index.Names[id] = finalName
	return id, finalName, dir, nil
}

// uniqueName returns a case-folded-unique variant of base by appending
// " (copy)", " (copy 2)", … if any other conversation already holds the
// name. Excludes excludeID so a no-op rename of an existing conversation
// to its current name doesn't trigger a copy suffix.
func (fs *FileSessionStore) uniqueName(base, excludeID string) string {
	taken := func(candidate string) bool {
		folded := strings.ToLower(candidate)
		for id, n := range fs.index.Names {
			if id == excludeID {
				continue
			}
			if strings.ToLower(n) == folded {
				return true
			}
		}
		return false
	}
	if !taken(base) {
		return base
	}
	if c := base + " (copy)"; !taken(c) {
		return c
	}
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s (copy %d)", base, i)
		if !taken(c) {
			return c
		}
	}
}

// ensureConvDir returns the existing folder for convID, or creates an
// "Untitled--<id>" fallback folder if no folder is registered. Returns
// an error if the conversation was deleted this session, so a racing
// worker save can't recreate the folder as a ghost orphan.
//
// In normal flow CreateConversationFolder has already created the folder
// with its canonical name before any worker saves to it; the "Untitled"
// fallback exists only as a regression guard for callers that skip the
// create endpoint.
func (fs *FileSessionStore) ensureConvDir(convID string) (string, error) {
	if fs.deletedIDs[convID] {
		return "", fmt.Errorf("cannot save conversation %s: it has been deleted", convID)
	}
	if dir, ok := fs.ConvDir(convID); ok {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("ensure conv dir: %w", err)
		}
		return dir, nil
	}
	dirName := BuildDirName("Untitled", convID)
	dir := filepath.Join(fs.jugglerDir(), dirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create conv dir: %w", err)
	}
	if fs.index == nil {
		fs.index = NewConvDirIndex()
	}
	fs.index.ByID[convID] = dir
	fs.index.Names[convID] = "Untitled"
	return dir, nil
}

// binDir returns the .juggler/trash directory path.
func (fs *FileSessionStore) binDir() string {
	return filepath.Join(fs.jugglerDir(), "trash")
}

// jugglerDir returns the .juggler directory path
func (fs *FileSessionStore) jugglerDir() string {
	return filepath.Join(fs.projectPath, ".juggler")
}

// sessionGlobalsPath returns the path to session.json
func (fs *FileSessionStore) sessionGlobalsPath() string {
	return filepath.Join(fs.jugglerDir(), "session.json")
}

// Save persists the session to disk in {projectPath}/.juggler/
func (fs *FileSessionStore) Save(session *Session) error {
	if err := session.Validate(); err != nil {
		return fmt.Errorf("invalid session: %w", err)
	}

	globalsPath := fs.sessionGlobalsPath()
	globalsData, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal session globals: %w", err)
	}
	// Atomic temp+rename (matching SaveConversationBinary) so a crash mid-write
	// can't leave a truncated/torn session.json.
	tmp := globalsPath + ".tmp"
	if err := os.WriteFile(tmp, globalsData, 0644); err != nil {
		return fmt.Errorf("failed to write session globals: %w", err)
	}
	if err := atomicio.RobustRename(tmp, globalsPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to rename session globals: %w", err)
	}

	return nil
}

// SaveConversationBinary writes the Yjs document to <convDir>/doc.yjs.
// If the conversation has no folder yet, an "Untitled--<id>" folder is
// created; the frontend can rename it later via RenameConversation.
// Uses atomic temp+rename to avoid torn writes on crash.
func (fs *FileSessionStore) SaveConversationBinary(convID string, yjsData []byte) error {
	dir, err := fs.ensureConvDir(convID)
	if err != nil {
		return err
	}
	dst := docPath(dir)
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, yjsData, 0o644); err != nil {
		return fmt.Errorf("failed to write conversation binary: %w", err)
	}
	if err := atomicio.RobustRename(tmp, dst); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to rename conversation binary: %w", err)
	}
	return nil
}

// LoadConversationBinary reads the Yjs document from <convDir>/doc.yjs.
// Returns ErrConversationNotFound if the conversation has no folder.
func (fs *FileSessionStore) LoadConversationBinary(convID string) ([]byte, error) {
	dir, ok := fs.ConvDir(convID)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	data, err := os.ReadFile(docPath(dir))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
		}
		return nil, fmt.Errorf("failed to read conversation binary: %w", err)
	}
	return data, nil
}

// RenameConversation atomically renames a conversation's folder to reflect
// a new human-readable name. Returns ErrInvalidName for empty/whitespace
// input and ErrNameCollision (case-folded) if another conversation already
// uses that name. The newly canonical name (after sanitization) is returned.
func (fs *FileSessionStore) RenameConversation(convID, newName string) (string, error) {
	if strings.TrimSpace(newName) == "" {
		return "", ErrInvalidName
	}
	sanitized := SanitizeName(newName)
	if sanitized == "" {
		return "", ErrInvalidName
	}

	oldDir, ok := fs.ConvDir(convID)
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}

	// Case-folded collision check across all OTHER conversations. Mac/Win
	// case-insensitive filesystems would otherwise let two folders coexist
	// in different casings until the rename collapses one onto the other.
	folded := strings.ToLower(sanitized)
	for id, n := range fs.index.Names {
		if id == convID {
			continue
		}
		if strings.ToLower(n) == folded {
			return "", ErrNameCollision
		}
	}

	if fs.index.Names[convID] == sanitized {
		return sanitized, nil // no-op
	}

	newDir := filepath.Join(fs.jugglerDir(), BuildDirName(sanitized, convID))
	if oldDir == newDir {
		return sanitized, nil
	}
	if err := atomicio.RobustRename(oldDir, newDir); err != nil {
		return "", fmt.Errorf("rename conv dir: %w", err)
	}
	fs.index.ByID[convID] = newDir
	fs.index.Names[convID] = sanitized
	return sanitized, nil
}

// removeConversationFiles deletes (or trashes) a conversation's folder and
// records the deletion so any racing worker save is rejected by ensureConvDir
// before it can recreate the folder as an orphan ghost.
// When permanent is false the folder is moved to the OS trash (giving the user
// a recovery path); when true it is permanently deleted (use for test teardown
// or when the trash path is inappropriate).
func (fs *FileSessionStore) removeConversationFiles(convID string, permanent bool) error {
	if fs.deletedIDs == nil {
		fs.deletedIDs = make(map[string]bool)
	}
	fs.deletedIDs[convID] = true

	dir, ok := fs.ConvDir(convID)
	if !ok {
		return nil
	}
	var err error
	if permanent {
		err = os.RemoveAll(dir)
	} else {
		err = trashOrRemove(dir)
	}
	if err != nil {
		return fmt.Errorf("failed to delete conversation dir: %w", err)
	}
	delete(fs.index.ByID, convID)
	delete(fs.index.Names, convID)
	return nil
}

// BinConversation moves a conversation's folder from .juggler/ to
// .juggler/trash/. Returns ErrConversationNotFound if the conversation has no
// active folder. Sets deletedIDs[convID]=true to close the worker-save race
// window (matches removeConversationFiles); RestoreConversation clears it.
func (fs *FileSessionStore) BinConversation(convID string) error {
	oldDir, ok := fs.ConvDir(convID)
	if !ok {
		return fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	if err := os.MkdirAll(fs.binDir(), 0o755); err != nil {
		return fmt.Errorf("create bin dir: %w", err)
	}
	basename := filepath.Base(oldDir)
	newDir := filepath.Join(fs.binDir(), basename)
	if err := atomicio.RobustRename(oldDir, newDir); err != nil {
		return fmt.Errorf("bin conv dir: %w", err)
	}
	name := fs.index.Names[convID]
	delete(fs.index.ByID, convID)
	delete(fs.index.Names, convID)
	if fs.binIndex == nil {
		fs.binIndex = NewConvDirIndex()
	}
	fs.binIndex.ByID[convID] = newDir
	fs.binIndex.Names[convID] = name
	if fs.deletedIDs == nil {
		fs.deletedIDs = make(map[string]bool)
	}
	fs.deletedIDs[convID] = true
	return nil
}

// RestoreConversation moves a conversation's folder from .juggler/trash/ back
// to .juggler/. Returns ErrConversationNotFound if the conversation is not in
// the bin.
func (fs *FileSessionStore) RestoreConversation(convID string) error {
	if fs.binIndex == nil {
		return fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	oldDir, ok := fs.binIndex.ByID[convID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrConversationNotFound, convID)
	}
	basename := filepath.Base(oldDir)
	newDir := filepath.Join(fs.jugglerDir(), basename)
	if err := atomicio.RobustRename(oldDir, newDir); err != nil {
		return fmt.Errorf("restore conv dir: %w", err)
	}
	name := fs.binIndex.Names[convID]
	delete(fs.binIndex.ByID, convID)
	delete(fs.binIndex.Names, convID)
	fs.index.ByID[convID] = newDir
	fs.index.Names[convID] = name
	delete(fs.deletedIDs, convID)
	return nil
}

// removeBinnedConversationFiles permanently removes (via OS trash where
// available) a conversation folder from .juggler/trash/.
func (fs *FileSessionStore) removeBinnedConversationFiles(convID string) error {
	if fs.binIndex == nil {
		return nil
	}
	dir, ok := fs.binIndex.ByID[convID]
	if !ok {
		return nil
	}
	if err := trashOrRemove(dir); err != nil {
		return fmt.Errorf("failed to delete binned conv dir: %w", err)
	}
	delete(fs.binIndex.ByID, convID)
	delete(fs.binIndex.Names, convID)
	return nil
}

// EmptyBin permanently removes (via OS trash) every conversation currently in
// .juggler/trash/, returning the ids removed. This is the synchronous form used
// by direct callers and tests; the server empties the bin via emptyBinDeferred
// so the slow OS-trash step runs off the actor goroutine.
func (fs *FileSessionStore) EmptyBin() ([]string, error) {
	removed, trashPath, err := fs.emptyBinDeferred()
	if err != nil {
		return nil, err
	}
	if trashPath != "" {
		if err := trashOrRemove(trashPath); err != nil {
			return removed, fmt.Errorf("empty bin: trash %q: %w", trashPath, err)
		}
	}
	return removed, nil
}

// emptyBinDeferred performs the in-memory half of emptying the bin: it snapshots
// the binned ids, atomically renames the whole .juggler/trash/ directory aside
// to a unique sibling, and clears the bin index. All of this is fast metadata
// work — no per-conversation filesystem traversal — so it is cheap to run on the
// actor goroutine. It returns the emptied ids and the path of the moved-aside
// directory; the caller must trash that directory (a single OS trash operation,
// hence one "moved to trash" sound instead of one per conversation) off the hot
// path. trashPath is "" when the bin was already empty.
func (fs *FileSessionStore) emptyBinDeferred() (removed []string, trashPath string, err error) {
	if fs.binIndex == nil || len(fs.binIndex.ByID) == 0 {
		return nil, "", nil
	}
	ids := make([]string, 0, len(fs.binIndex.ByID))
	for id := range fs.binIndex.ByID {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	// The index is non-empty, so the directory should exist; if it somehow does
	// not, there is nothing on disk to trash — just clear the index below.
	binDir := fs.binDir()
	if _, statErr := os.Stat(binDir); statErr == nil {
		trashPath = fs.uniqueEmptyingPath()
		if renameErr := atomicio.RobustRename(binDir, trashPath); renameErr != nil {
			return nil, "", fmt.Errorf("empty bin: move aside: %w", renameErr)
		}
	}

	fs.binIndex.ByID = map[string]string{}
	fs.binIndex.Names = map[string]string{}
	return ids, trashPath, nil
}

// uniqueEmptyingPath returns a sibling of .juggler/trash/ that does not yet
// exist, used as the move-aside target when emptying the bin. The nanosecond
// timestamp plus a disambiguating counter guarantees uniqueness even across
// rapid successive empties.
func (fs *FileSessionStore) uniqueEmptyingPath() string {
	base := filepath.Join(fs.jugglerDir(), "trash.emptying")
	for i := 0; ; i++ {
		p := fmt.Sprintf("%s-%d-%d", base, time.Now().UnixNano(), i)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
}

// orphanedEmptyingDirs returns any leftover trash.emptying-* directories under
// .juggler/ (see emptyBinDeferred). These exist only when a prior EmptyBin's
// off-actor trash step was interrupted before it finished; the caller sweeps
// them at startup.
func (fs *FileSessionStore) orphanedEmptyingDirs() []string {
	matches, _ := filepath.Glob(filepath.Join(fs.jugglerDir(), "trash.emptying-*"))
	return matches
}

// dirSizeBytes returns the total size, in bytes, of every regular file under
// root (recursively). A missing directory (an empty bin never creates
// .juggler/trash) yields 0. Per-entry errors are swallowed rather than
// aborting the walk, so a file vanishing mid-scan (e.g. a concurrent
// EmptyBin) still produces a sensible tally instead of nothing.
func dirSizeBytes(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// BinSizeBytes returns the on-disk size of .juggler/trash/ (all binned
// conversations). It walks the filesystem and touches none of the store's
// in-memory indexes, so — unlike the other FileSessionStore methods — it is
// safe to call off the SessionManager actor goroutine (the periodic bin-size
// monitor does exactly that).
func (fs *FileSessionStore) BinSizeBytes() int64 {
	return dirSizeBytes(fs.binDir())
}

// lastActivityTime returns the wall-clock time of the most recent real
// edit to a conversation folder. The right signal is the newest mtime
// among files in <convDir>/txns/ — each LLM round-trip writes one blob
// and nothing else does, so simply opening or migrating the conv never
// bumps it. Falls back to doc.yjs mtime, then the folder itself, so a
// conv that was binned before any LLM turn still gets a sensible
// timestamp.
func lastActivityTime(convDir string) (time.Time, error) {
	txnsDir := filepath.Join(convDir, "txns")
	entries, err := os.ReadDir(txnsDir)
	if err == nil {
		var newest time.Time
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			if info.ModTime().After(newest) {
				newest = info.ModTime()
			}
		}
		if !newest.IsZero() {
			return newest, nil
		}
	}
	if st, err := os.Stat(docPath(convDir)); err == nil {
		return st.ModTime(), nil
	}
	st, err := os.Stat(convDir)
	if err != nil {
		return time.Time{}, err
	}
	return st.ModTime(), nil
}

// BinnedConvList returns metadata for every conversation in .juggler/trash/,
// sorted most-recently-modified first. "Modified" means the last real LLM
// transaction (see lastActivityTime). Folders whose timestamp can't be resolved
// are skipped.
func (fs *FileSessionStore) BinnedConvList() []BinnedConvInfo {
	if fs.binIndex == nil {
		return []BinnedConvInfo{}
	}
	out := make([]BinnedConvInfo, 0, len(fs.binIndex.ByID))
	type rec struct {
		info  BinnedConvInfo
		mtime int64
	}
	recs := make([]rec, 0, len(fs.binIndex.ByID))
	for id, dir := range fs.binIndex.ByID {
		t, err := lastActivityTime(dir)
		if err != nil {
			continue
		}
		recs = append(recs, rec{
			info: BinnedConvInfo{
				ID:             id,
				Name:           fs.binIndex.Names[id],
				LastModifiedAt: t.UTC().Format("2006-01-02T15:04:05Z"),
			},
			mtime: t.UnixNano(),
		})
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].mtime > recs[j].mtime })
	for _, r := range recs {
		out = append(out, r.info)
	}
	return out
}

// Load retrieves the session from disk. Disk is the source of truth for
// both the conversation set and the human-readable name (folder name);
// session.json carries only the manifest (order, active, etc.).
func (fs *FileSessionStore) Load() (*Session, error) {
	idx, err := ScanConvDirs(fs.jugglerDir())
	if err != nil {
		return nil, fmt.Errorf("scan conv dirs: %w", err)
	}
	fs.index = idx

	binIdx, err := ScanConvDirs(fs.binDir())
	if err != nil {
		return nil, fmt.Errorf("scan bin dirs: %w", err)
	}
	fs.binIndex = binIdx

	globalsPath := fs.sessionGlobalsPath()
	globalsData, err := os.ReadFile(globalsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrSessionNotFound
		}
		return nil, fmt.Errorf("failed to read session globals: %w", err)
	}

	var session Session
	if err := json.Unmarshal(globalsData, &session); err != nil {
		return nil, fmt.Errorf("failed to unmarshal session globals: %w", err)
	}
	session.Conversations = []json.RawMessage{}

	// Reconcile manifest's ConversationOrder against the on-disk index:
	// drop ids that no longer have a folder, append orphan folders that
	// aren't yet in the order. Persist if anything changed.
	if fs.reconcileConversationOrder(&session) {
		if err := fs.Save(&session); err != nil {
			jlog.Error("[session] failed to persist reconciled order: %v", err)
		}
	}

	if err := session.Validate(); err != nil {
		return nil, fmt.Errorf("loaded session is invalid: %w", err)
	}
	return &session, nil
}

// reconcileConversationOrder syncs ConversationOrder with the per-conv
// folders actually present on disk (fs.index). IDs whose folder is gone
// are dropped (along with the activeConversation pointer if it pointed
// at them); folders on disk that aren't in the order are appended in
// deterministic (lexical) order so the tab bar doesn't shuffle on every
// startup. Returns true if the order changed.
func (fs *FileSessionStore) reconcileConversationOrder(session *Session) bool {
	if fs.index == nil {
		return false
	}
	onDisk := fs.index.ByID
	changed := false

	kept := make([]string, 0, len(session.ConversationOrder))
	for _, id := range session.ConversationOrder {
		if _, ok := onDisk[id]; ok {
			kept = append(kept, id)
			continue
		}
		if session.ActiveConversationID == id {
			session.ActiveConversationID = ""
		}
		changed = true
	}
	session.ConversationOrder = kept

	inOrder := map[string]bool{}
	for _, id := range session.ConversationOrder {
		inOrder[id] = true
	}
	var orphans []string
	for id := range onDisk {
		if !inOrder[id] {
			orphans = append(orphans, id)
		}
	}
	if len(orphans) > 0 {
		sort.Strings(orphans)
		session.ConversationOrder = append(session.ConversationOrder, orphans...)
		changed = true
	}
	return changed
}
