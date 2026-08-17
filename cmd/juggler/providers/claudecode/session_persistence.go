//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// diskSessionState is the on-disk shape of the persistent fields of an
// activeSession. Saved as `<projectPath>/.juggler/<name>--<convID>/claude_session.json`
// after every successful turn so juggler restarts can resume the claude
// session via --resume <uuid> instead of cold-starting from full history.
type diskSessionState struct {
	SessionUUID      string   `json:"sessionUUID"`
	HeldCount        *int     `json:"heldCount,omitempty"`
	SentCount        int      `json:"sentCount"`
	SentHash         uint64   `json:"sentHash"` // legacy aggregate; covers system prompt + first SentCount messages
	SentSystemHash   uint64   `json:"sentSystemHash,omitempty"`
	SentMsgHashes    []uint64 `json:"sentMsgHashes,omitempty"`
	Model            string   `json:"model,omitempty"`
	LastCacheRead    int      `json:"lastCacheRead,omitempty"`
	LastTurnUnixNano int64    `json:"lastTurnUnixNano,omitempty"`
}

// sessionDiskPath returns the path for the claude_session.json sidecar inside
// the conversation's own folder. Returns "" if the folder cannot be found.
func sessionDiskPath(workingDir, convID string) string {
	if workingDir == "" || convID == "" {
		return ""
	}
	idx, err := core.ScanConvDirs(filepath.Join(workingDir, ".juggler"))
	if err != nil {
		return ""
	}
	folder, ok := idx.ByID[convID]
	if !ok {
		return ""
	}
	return filepath.Join(folder, "claude_session.json")
}

// legacySessionDiskPath returns the old flat sidecar path used before
// sessions were moved into per-conversation folders.
func legacySessionDiskPath(workingDir, convID string) string {
	if workingDir == "" || convID == "" {
		return ""
	}
	return filepath.Join(workingDir, ".juggler", convID+".claudecode.json")
}

func loadDiskSession(workingDir, convID string) *activeSession {
	p := sessionDiskPath(workingDir, convID)
	legacy := legacySessionDiskPath(workingDir, convID)

	var data []byte
	var err error
	if p != "" {
		data, err = os.ReadFile(p)
	}
	if err != nil || len(data) == 0 {
		// Fall back to legacy location and migrate on success.
		if legacy == "" {
			return nil
		}
		data, err = os.ReadFile(legacy)
		if err != nil {
			return nil
		}
	}
	var d diskSessionState
	if err := json.Unmarshal(data, &d); err != nil {
		jlog.Debug("loadDiskSession: corrupt sidecar: %v", err)
		return nil
	}
	if d.SessionUUID == "" {
		return nil
	}
	heldCount := d.SentCount
	if d.HeldCount != nil {
		heldCount = *d.HeldCount
	}
	jlog.Debug("loadDiskSession: restored uuid=%s heldCount=%d sentCount=%d for %s", d.SessionUUID, heldCount, d.SentCount, convID)
	s := &activeSession{
		sessionUUID:    d.SessionUUID,
		heldCount:      heldCount,
		sentCount:      d.SentCount,
		sentHash:       d.SentHash,
		sentSystemHash: d.SentSystemHash,
		sentMsgHashes:  d.SentMsgHashes,
		model:          d.Model,
		lastCacheRead:  d.LastCacheRead,
	}
	if d.LastTurnUnixNano > 0 {
		s.lastTurnAt = time.Unix(0, d.LastTurnUnixNano)
	}
	// Migrate: remove legacy file now that we have a valid session to re-save.
	if legacy != "" {
		_ = os.Remove(legacy)
	}
	return s
}

func saveDiskSession(workingDir, convID string, sess *activeSession) {
	p := sessionDiskPath(workingDir, convID)
	if p == "" || sess == nil || sess.sessionUUID == "" {
		return
	}
	heldCount := sess.heldCount
	d := diskSessionState{
		SessionUUID:    sess.sessionUUID,
		HeldCount:      &heldCount,
		SentCount:      sess.sentCount,
		SentHash:       sess.sentHash,
		SentSystemHash: sess.sentSystemHash,
		SentMsgHashes:  sess.sentMsgHashes,
		Model:          sess.model,
		LastCacheRead:  sess.lastCacheRead,
	}
	if !sess.lastTurnAt.IsZero() {
		d.LastTurnUnixNano = sess.lastTurnAt.UnixNano()
	}
	data, err := json.Marshal(&d)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		jlog.Debug("saveDiskSession: mkdir failed for %s: %v", p, err)
		return
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		jlog.Debug("saveDiskSession: write failed for %s: %v", p, err)
	}
}

func deleteDiskSession(workingDir, convID string) {
	if p := sessionDiskPath(workingDir, convID); p != "" {
		_ = os.Remove(p)
	}
	if p := legacySessionDiskPath(workingDir, convID); p != "" {
		_ = os.Remove(p)
	}
}
