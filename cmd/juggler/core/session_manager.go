//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"sync"
	"time"

	"juggler/internal/jlog"
)

// binSizeInterval is how often the low-priority background monitor recomputes
// the on-disk size of .juggler/trash/ as a backstop. Bin contents change
// rarely and the tally is only cosmetic (a "(50 MB)" hint on the Bin button
// and Empty-Bin action), so this is deliberately coarse; user-initiated
// bin/restore/delete/empty operations nudge an immediate recompute on top of
// it (see kickBinSizeRecompute).
const binSizeInterval = 5 * time.Minute

// SessionManager owns the in-memory *Session and serializes all access via a
// single goroutine. Operations are typed closures sent over read/write
// channels; the actor goroutine runs them on the shared state.
//
// Read commands (GetSession, ConvDir, ConvNames, ListBinnedConversations,
// LoadConversationBinary) go on readChan; write commands (everything else) on
// writeChan. The run loop drains pending reads before picking a write, so
// in-memory reads never queue behind disk-writing operations.
//
// Channel capacity 64 is well above the steady-state depth: each websocket
// frame may produce one read; debounced saves produce one write every couple
// of seconds.
type SessionManager struct {
	state        *sessionState
	readChan     chan sessionTask
	writeChan    chan sessionTask
	shutdownChan chan struct{}
	shutdownOnce sync.Once
	scratchDir   string // non-empty in no-project mode; removed on Shutdown
	projectPath  string
	// binSizeKick nudges the background bin-size monitor to recompute now
	// (buffered/size-1: sends are non-blocking and coalesce).
	binSizeKick chan struct{}
}

// sessionState is the mutable cell owned by the actor goroutine. Closures
// receive *sessionState so they can both read and replace s.session.
type sessionState struct {
	store   *FileSessionStore
	session *Session
	// binSizeBytes caches the on-disk size of .juggler/trash/, refreshed by
	// the background bin-size monitor. Read on the actor; written only via a
	// task the monitor posts, so it never needs a lock.
	binSizeBytes int64
}

// sessionTask is the unit of work the actor goroutine runs.
type sessionTask func(*sessionState)

// SessionManagerConfig configures the session manager.
type SessionManagerConfig struct {
	Store       *FileSessionStore
	ProjectPath string
}

// NewSessionManager creates a new session manager.
func NewSessionManager(cfg SessionManagerConfig) (*SessionManager, error) {
	if cfg.Store == nil {
		return nil, fmt.Errorf("store is required")
	}
	if cfg.ProjectPath == "" {
		return nil, fmt.Errorf("project path is required")
	}
	return startManager(cfg.Store, cfg.ProjectPath, ""), nil
}

// NewSessionManagerForPath constructs a SessionManager for the given project
// path, or an ephemeral one (backed by a temp directory) if the path is empty.
// The ephemeral mode supports "no project loaded" startup without forcing the
// rest of the server to special-case a nil manager.
func NewSessionManagerForPath(projectPath string) (*SessionManager, error) {
	if projectPath == "" {
		scratch, err := os.MkdirTemp("", "juggler-noproject-")
		if err != nil {
			return nil, fmt.Errorf("failed to create scratch dir: %w", err)
		}
		store, err := NewFileSessionStore(scratch)
		if err != nil {
			return nil, err
		}
		return startManager(store, "", scratch), nil
	}
	store, err := NewFileSessionStore(projectPath)
	if err != nil {
		return nil, err
	}
	return startManager(store, projectPath, ""), nil
}

func startManager(store *FileSessionStore, projectPath, scratchDir string) *SessionManager {
	m := &SessionManager{
		state:        &sessionState{store: store},
		readChan:     make(chan sessionTask, 64),
		writeChan:    make(chan sessionTask, 64),
		shutdownChan: make(chan struct{}),
		scratchDir:   scratchDir,
		projectPath:  projectPath,
		binSizeKick:  make(chan struct{}, 1),
	}
	go m.run()
	go m.runBinSizeMonitor(store)
	go m.sweepOrphanedEmptyingDirs(store)
	return m
}

// sweepOrphanedEmptyingDirs trashes any .juggler/trash.emptying-* directories
// left behind by an EmptyBin whose background trash step was interrupted (e.g.
// the process exited before it finished). Runs once at startup, off the actor,
// so it never delays session load. Best-effort: failures are logged, not fatal.
func (m *SessionManager) sweepOrphanedEmptyingDirs(store *FileSessionStore) {
	for _, dir := range store.orphanedEmptyingDirs() {
		if err := trashOrRemove(dir); err != nil {
			jlog.Error("[session] failed to sweep orphaned empty-bin dir %q: %v", dir, err)
		}
	}
}

// runBinSizeMonitor is a low-priority background goroutine that keeps
// sessionState.binSizeBytes fresh. It recomputes on a coarse ticker and
// whenever a bin mutation nudges binSizeKick, then posts the result to the
// actor via writeChan so the cached value is only ever mutated on the actor
// goroutine. The size walk itself runs here, off the actor, so a large bin
// never stalls session reads/writes. store is captured directly (its
// projectPath is immutable and BinSizeBytes touches no in-memory index), so
// this goroutine shares no mutable state with the actor.
func (m *SessionManager) runBinSizeMonitor(store *FileSessionStore) {
	ticker := time.NewTicker(binSizeInterval)
	defer ticker.Stop()

	recompute := func() {
		size := store.BinSizeBytes()
		select {
		case m.writeChan <- func(s *sessionState) { s.binSizeBytes = size }:
		case <-m.shutdownChan:
		}
	}

	recompute() // seed the cache promptly after startup
	for {
		select {
		case <-ticker.C:
			recompute()
		case <-m.binSizeKick:
			recompute()
		case <-m.shutdownChan:
			return
		}
	}
}

// kickBinSizeRecompute nudges the background monitor to recompute the bin
// size now, without blocking: a full kick channel already means a recompute
// is pending, so the extra signal is dropped.
func (m *SessionManager) kickBinSizeRecompute() {
	select {
	case m.binSizeKick <- struct{}{}:
	default:
	}
}

// BinSizeBytes returns the most recently cached on-disk size of
// .juggler/trash/. The value is maintained by the background monitor, so a
// read is a cheap in-memory lookup — it never triggers a filesystem walk.
func (m *SessionManager) BinSizeBytes() int64 {
	v, _ := runRead(m, func(s *sessionState) (int64, error) {
		return s.binSizeBytes, nil
	})
	return v
}

// run is the actor goroutine that owns the session and all file I/O.
// Reads are served before writes when both are pending — small in-memory
// lookups never queue behind a disk-writing Save.
func (m *SessionManager) run() {
	session, err := m.state.store.Load()
	if err != nil {
		session = NewSession()
		if err := m.state.store.Save(session); err != nil {
			jlog.Error("[session] failed to create session: %v", err)
		}
	}
	m.state.session = session

	for {
		// Drain pending reads before considering a write.
		select {
		case t := <-m.readChan:
			t(m.state)
			continue
		default:
		}
		select {
		case t := <-m.readChan:
			t(m.state)
		case t := <-m.writeChan:
			t(m.state)
		case <-m.shutdownChan:
			return
		}
	}
}

// Shutdown gracefully shuts down the actor goroutine and removes any
// ephemeral scratch directory created for no-project mode.
func (m *SessionManager) Shutdown() {
	m.shutdownOnce.Do(func() {
		close(m.shutdownChan)
		if m.scratchDir != "" {
			os.RemoveAll(m.scratchDir)
		}
	})
}

// runRead submits fn to the read channel and waits for its result.
func runRead[T any](m *SessionManager, fn func(*sessionState) (T, error)) (T, error) {
	out := make(chan struct {
		v   T
		err error
	}, 1)
	m.readChan <- func(s *sessionState) {
		v, err := fn(s)
		out <- struct {
			v   T
			err error
		}{v, err}
	}
	r := <-out
	return r.v, r.err
}

// runWrite submits fn to the write channel and waits for its result.
func runWrite[T any](m *SessionManager, fn func(*sessionState) (T, error)) (T, error) {
	out := make(chan struct {
		v   T
		err error
	}, 1)
	m.writeChan <- func(s *sessionState) {
		v, err := fn(s)
		out <- struct {
			v   T
			err error
		}{v, err}
	}
	r := <-out
	return r.v, r.err
}

// ============================================================================
// Wrapper methods
// ============================================================================

// GetSession returns a private snapshot of the session. The clone is taken on
// the actor goroutine, so it is a consistent point-in-time copy; callers then
// own it outright. Because the live session never escapes the actor, the only
// way to change session state is an actor method (Update / PatchMetadata /
// SetWindowState) — mutating the result of GetSession from an HTTP handler is a
// no-op on the real state, which is what makes the concurrent-map-write
// server-crash structurally impossible rather than merely discouraged.
func (m *SessionManager) GetSession() *Session {
	v, _ := runRead(m, func(s *sessionState) (*Session, error) {
		return s.session.Clone(), nil
	})
	return v
}

// Update is the single entry point for arbitrary session mutation. mutate runs
// on the actor goroutine with exclusive access to the live *Session; the
// manifest is then validated and persisted. There is deliberately no exported
// way to hand back an externally-built session and swap it in: that
// build-outside / replace-inside shape would let two HTTP goroutines race the
// same map. Here the mutation happens in-place under the actor, atomic with
// respect to every other session operation.
func (m *SessionManager) Update(mutate func(*Session) error) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if s.session == nil {
			return struct{}{}, nil
		}
		if err := mutate(s.session); err != nil {
			return struct{}{}, err
		}
		if err := s.session.Validate(); err != nil {
			return struct{}{}, fmt.Errorf("invalid session: %w", err)
		}
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// CreateConversation creates a new conversation folder, using requestedID when
// supplied or allocating a fresh id otherwise, and prepends the id to
// ConversationOrder. Returns the id and canonical name (which gets a
// " (copy N)" suffix on case-folded collision).
//
// Single authoritative entry point for creating a new conversation: the
// folder exists with its final name before this call returns, and the
// worker subsequently spawned for the id resolves the folder by id via
// ensureConvDir.
func (m *SessionManager) CreateConversation(name string, requestedID ...string) (string, string, error) {
	type result struct {
		id   string
		name string
	}
	idHint := ""
	if len(requestedID) > 0 {
		idHint = requestedID[0]
	}
	r, err := runWrite(m, func(s *sessionState) (result, error) {
		id, finalName, _, err := s.store.CreateConversationFolder(name, idHint)
		if err != nil {
			return result{}, err
		}
		if !slices.Contains(s.session.ConversationOrder, id) {
			s.session.ConversationOrder = append([]string{id}, s.session.ConversationOrder...)
		}
		if err := s.store.Save(s.session); err != nil {
			return result{}, err
		}
		return result{id, finalName}, nil
	})
	if err != nil {
		return "", "", err
	}
	return r.id, r.name, nil
}

// SaveConversationBinary writes the Yjs document for an existing
// conversation to disk. ConversationOrder is owned by CreateConversation;
// callers must register the id there before saving bytes for it.
func (m *SessionManager) SaveConversationBinary(convID string, yjsData []byte) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		return struct{}{}, s.store.SaveConversationBinary(convID, yjsData)
	})
	return err
}

// SaveConversationBinaryIfOwned persists the Yjs document only when convID is a
// conversation this project already owns (has a registered on-disk folder),
// reporting whether the save happened. It is the persistence path for the
// conversation-worker manager, which is server-lifetime: its workers can
// outlive a SwitchProject, so a worker created under one project must never
// write its conversation into whichever project is loaded now. Unlike
// SaveConversationBinary — which fabricates an "Untitled--<id>" folder for an
// unknown id (a deliberate low-level store convenience some tests rely on) —
// this refuses the unowned id and returns (false, nil): a benign no-op, since
// the project that actually owns the conversation persists it when it is the
// loaded project. The ownership check and the write happen in one actor turn,
// so a concurrent SwitchProject can never wedge a save between them.
func (m *SessionManager) SaveConversationBinaryIfOwned(convID string, yjsData []byte) (bool, error) {
	return runWrite(m, func(s *sessionState) (bool, error) {
		if _, ok := s.store.ConvDir(convID); !ok {
			return false, nil
		}
		return true, s.store.SaveConversationBinary(convID, yjsData)
	})
}

// LoadConversationBinary loads binary Yjs conversation data.
func (m *SessionManager) LoadConversationBinary(convID string) ([]byte, error) {
	return runRead(m, func(s *sessionState) ([]byte, error) {
		return s.store.LoadConversationBinary(convID)
	})
}

// ReorderConversations updates the conversation order. The incoming order may
// mention only a subset of conversations (a client that knows only some — e.g.
// one lane of the multi-iframe test pool, or any viewer mid-sync); it is merged
// onto the manifest so unmentioned conversations keep their slots rather than
// being dropped. When the client posts the full set (the production case) the
// merge is an exact replacement.
func (m *SessionManager) ReorderConversations(order []string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		s.session.ConversationOrder = mergeConversationOrder(s.session.ConversationOrder, order)
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// mergeConversationOrder re-slots the ids named in `desired` (in desired
// sequence) into the positions they currently occupy in `current`, leaving ids
// absent from `desired` exactly where they are. Ids in `desired` not present in
// `current` are appended. With `desired` covering all of `current`'s ids this
// is a straight replacement; with a subset it reorders only that subset.
func mergeConversationOrder(current, desired []string) []string {
	desiredSet := make(map[string]bool, len(desired))
	for _, id := range desired {
		desiredSet[id] = true
	}
	currentSet := make(map[string]bool, len(current))
	for _, id := range current {
		currentSet[id] = true
	}
	// Desired ids that actually exist now, in desired order — these fill the
	// slots currently held by any desired id.
	queue := make([]string, 0, len(desired))
	for _, id := range desired {
		if currentSet[id] {
			queue = append(queue, id)
		}
	}
	result := make([]string, 0, len(current)+len(desired))
	qi := 0
	for _, id := range current {
		if desiredSet[id] {
			result = append(result, queue[qi])
			qi++
		} else {
			result = append(result, id)
		}
	}
	// New arrivals (in desired but not yet on disk in the order) go last.
	for _, id := range desired {
		if !currentSet[id] {
			result = append(result, id)
		}
	}
	return result
}

// DeleteConversation removes the conversation's folder and session manifest entry.
// Set permanent=true for test teardown (permanent delete); false for user-initiated
// deletion (moves to OS trash so the user can recover if needed).
func (m *SessionManager) DeleteConversation(convID string, permanent bool) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		removeConvIDFromSession(s.session, convID)
		if err := s.store.removeConversationFiles(convID, permanent); err != nil {
			return struct{}{}, err
		}
		if err := s.store.Save(s.session); err != nil {
			return struct{}{}, fmt.Errorf("failed to save session after deleting conversation: %w", err)
		}
		return struct{}{}, nil
	})
	return err
}

// RenameConversation renames the conversation's folder on disk.
// Returns the canonical (post-sanitization) name on success.
func (m *SessionManager) RenameConversation(convID, newName string) (string, error) {
	return runWrite(m, func(s *sessionState) (string, error) {
		return s.store.RenameConversation(convID, newName)
	})
}

// ConvDir returns the absolute folder path for the conversation, or "",
// false if the conversation isn't known.
func (m *SessionManager) ConvDir(convID string) (string, bool) {
	type result struct {
		dir string
		ok  bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		dir, ok := s.store.ConvDir(convID)
		return result{dir, ok}, nil
	})
	return r.dir, r.ok
}

// ConvNames returns a snapshot of id → human name for every conversation
// folder currently on disk.
func (m *SessionManager) ConvNames() map[string]string {
	v, _ := runRead(m, func(s *sessionState) (map[string]string, error) {
		return s.store.ConvNames(), nil
	})
	return v
}

// BinConversation moves a conversation's folder to .juggler/bin/ and removes
// it from the active conversation order.
func (m *SessionManager) BinConversation(convID string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		removeConvIDFromSession(s.session, convID)
		if err := s.store.BinConversation(convID); err != nil {
			return struct{}{}, err
		}
		if err := s.store.Save(s.session); err != nil {
			return struct{}{}, fmt.Errorf("failed to save session after binning conversation: %w", err)
		}
		return struct{}{}, nil
	})
	if err == nil {
		m.kickBinSizeRecompute()
	}
	return err
}

// RestoreConversation moves a conversation's folder back from .juggler/bin/
// to .juggler/ and appends it to the active conversation order.
func (m *SessionManager) RestoreConversation(convID string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		if err := s.store.RestoreConversation(convID); err != nil {
			return struct{}{}, err
		}
		if !slices.Contains(s.session.ConversationOrder, convID) {
			s.session.ConversationOrder = append(s.session.ConversationOrder, convID)
		}
		if err := s.store.Save(s.session); err != nil {
			return struct{}{}, fmt.Errorf("failed to save session after restoring conversation: %w", err)
		}
		return struct{}{}, nil
	})
	if err == nil {
		m.kickBinSizeRecompute()
	}
	return err
}

// ListBinnedConversations returns metadata for all conversations in
// .juggler/bin/, sorted most-recently-modified first.
func (m *SessionManager) ListBinnedConversations() []BinnedConvInfo {
	v, _ := runRead(m, func(s *sessionState) ([]BinnedConvInfo, error) {
		return s.store.BinnedConvList(), nil
	})
	return v
}

// DeleteBinnedConversation permanently removes (via OS trash) a single
// conversation folder from .juggler/bin/.
func (m *SessionManager) DeleteBinnedConversation(convID string) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		return struct{}{}, s.store.removeBinnedConversationFiles(convID)
	})
	if err == nil {
		m.kickBinSizeRecompute()
	}
	return err
}

// EmptyBin permanently removes (via OS trash) every conversation currently in
// .juggler/trash/, returning the ids removed. The actor only does the fast
// in-memory move-aside (emptyBinDeferred); the actual OS-trash of the moved-
// aside directory runs on a background goroutine so a multi-GB bin neither
// stalls other session writes (new tabs, saves) nor plays one "moved to trash"
// sound per conversation — it is a single trash operation, off the hot path.
func (m *SessionManager) EmptyBin() ([]string, error) {
	type emptied struct {
		ids       []string
		trashPath string
	}
	r, err := runWrite(m, func(s *sessionState) (emptied, error) {
		ids, trashPath, e := s.store.emptyBinDeferred()
		return emptied{ids: ids, trashPath: trashPath}, e
	})
	if err != nil {
		return nil, err
	}
	if r.trashPath != "" {
		go func(path string) {
			if e := trashOrRemove(path); e != nil {
				jlog.Error("[session] empty bin: failed to trash %q: %v", path, e)
			}
			m.kickBinSizeRecompute()
		}(r.trashPath)
	}
	m.kickBinSizeRecompute()
	return r.ids, nil
}

// GetRuntimeInfo returns the runtime info for this manager's project.
func (m *SessionManager) GetRuntimeInfo() RuntimeInfo {
	return GetRuntimeInfo(m.projectPath)
}

// GetProjectPath returns the project path for this manager.
func (m *SessionManager) GetProjectPath() string {
	return m.projectPath
}

// GetWindowState returns the persisted native-window geometry for this
// project, or (zero, false) if none has been saved yet. Runs on the actor
// goroutine so it never races a concurrent save.
func (m *SessionManager) GetWindowState() (WindowState, bool) {
	type result struct {
		ws WindowState
		ok bool
	}
	r, _ := runRead(m, func(s *sessionState) (result, error) {
		if s.session == nil || s.session.WindowState == nil {
			return result{}, nil
		}
		return result{*s.session.WindowState, true}, nil
	})
	return r.ws, r.ok
}

// SetWindowState persists the native-window geometry for this project and
// writes the session manifest. Runs on the actor goroutine, so the read-
// modify-write is atomic with respect to every other session mutation.
func (m *SessionManager) SetWindowState(ws WindowState) error {
	_, err := runWrite(m, func(s *sessionState) (struct{}, error) {
		// No session loaded (e.g. a no-project window still at the picker) —
		// there's nowhere to store geometry, so no-op rather than panic.
		if s.session == nil {
			return struct{}{}, nil
		}
		stored := ws
		s.session.WindowState = &stored
		return struct{}{}, s.store.Save(s.session)
	})
	return err
}

// PatchMetadata applies a targeted key-by-key patch to the session metadata
// map and persists the manifest, returning the set of changed keys (nil value
// = key deleted). It is a thin convenience over Update: the mutation runs on the
// actor goroutine, the sole accessor of the live map, so the in-place
// read-modify-write is atomic with respect to every other session operation.
func (m *SessionManager) PatchMetadata(patch map[string]any) (map[string]any, error) {
	changed := make(map[string]any, len(patch))
	err := m.Update(func(s *Session) error {
		if s.Metadata == nil {
			s.Metadata = map[string]any{}
		}
		for key, value := range patch {
			if value == nil {
				delete(s.Metadata, key)
				changed[key] = nil
			} else {
				s.Metadata[key] = value
				changed[key] = value
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return changed, nil
}

// removeConvIDFromSession drops convID from ConversationOrder, Conversations,
// and clears ActiveConversationID if it pointed at convID. Shared by delete
// and bin flows.
func removeConvIDFromSession(s *Session, convID string) {
	newOrder := make([]string, 0, len(s.ConversationOrder))
	for _, id := range s.ConversationOrder {
		if id != convID {
			newOrder = append(newOrder, id)
		}
	}
	s.ConversationOrder = newOrder

	newConversations := make([]json.RawMessage, 0, len(s.Conversations))
	for _, conv := range s.Conversations {
		var obj struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(conv, &obj); err == nil && obj.ID != convID {
			newConversations = append(newConversations, conv)
		}
	}
	s.Conversations = newConversations
	if s.ActiveConversationID == convID {
		s.ActiveConversationID = ""
	}
}
