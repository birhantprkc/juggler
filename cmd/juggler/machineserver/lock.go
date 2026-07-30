//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofrs/flock"

	"juggler/internal/jlog"
)

// ServerInfo is the machine server's identity, written next to the machine
// lock so clients can discover the running server: read the info, probe
// /api/server/status, attach. It is the machine-scope analogue of the
// per-project core.InstanceInfo.
type ServerInfo struct {
	PID       int       `json:"pid"`
	Addr      string    `json:"addr"`
	Version   string    `json:"version"`
	StartedAt time.Time `json:"startedAt"`
}

// MachineLock enforces one machine server per machine via a flock under the
// user config dir (~/.juggler/server.lock), with ServerInfo JSON alongside it
// (server.json) as the discovery channel.
type MachineLock struct {
	lockPath string
	infoPath string
	flock    *flock.Flock
	info     ServerInfo
}

// NewMachineLock returns the lock manager rooted at configDir (normally
// userpaths.ConfigDir(); tests pass a temp dir).
func NewMachineLock(configDir string) *MachineLock {
	return &MachineLock{
		lockPath: filepath.Join(configDir, "server.lock"),
		infoPath: filepath.Join(configDir, "server.json"),
	}
}

// TryAcquire attempts to become the machine server. On success it writes our
// ServerInfo (with an empty Addr until UpdateAddr) and returns acquired=true.
// When the lock is held elsewhere it returns the holder's info, when readable,
// so the caller can report where the running server lives.
func (l *MachineLock) TryAcquire(version string) (acquired bool, existing *ServerInfo, err error) {
	if err := os.MkdirAll(filepath.Dir(l.lockPath), 0700); err != nil {
		return false, nil, fmt.Errorf("failed to create config directory: %w", err)
	}
	l.flock = flock.New(l.lockPath)
	locked, err := l.flock.TryLock()
	if err != nil {
		return false, nil, fmt.Errorf("failed to acquire machine lock: %w", err)
	}
	if !locked {
		return false, l.readInfo(), nil
	}
	l.info = ServerInfo{
		PID:       os.Getpid(),
		Version:   version,
		StartedAt: time.Now(),
	}
	if err := l.writeInfo(); err != nil {
		if unlockErr := l.flock.Unlock(); unlockErr != nil {
			jlog.Error("[machineserver] failed to release lock after write failure: %v", unlockErr)
		}
		return false, nil, fmt.Errorf("failed to write server info: %w", err)
	}
	return true, nil, nil
}

// UpdateAddr records the address the server actually bound to. TryAcquire runs
// before the listener exists, so the info starts with an empty Addr; this makes
// server.json authoritative for discovery. No-op if we don't hold the lock.
func (l *MachineLock) UpdateAddr(addr string) error {
	if l == nil || l.flock == nil || !l.flock.Locked() {
		return nil
	}
	l.info.Addr = addr
	return l.writeInfo()
}

// Release removes the server info and releases the lock. Info removal is
// non-fatal — the flock release is what actually frees the machine slot.
func (l *MachineLock) Release() error {
	if l == nil || l.flock == nil {
		return nil
	}
	if err := os.Remove(l.infoPath); err != nil && !os.IsNotExist(err) {
		jlog.Error("[machineserver] failed to remove server info file: %v", err)
	}
	return l.flock.Unlock()
}

func (l *MachineLock) writeInfo() error {
	data, err := json.MarshalIndent(l.info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(l.infoPath, data, 0600)
}

// readInfo returns the on-disk ServerInfo, or nil when it is missing or
// unparsable — callers treat nil as "holder unknown".
func (l *MachineLock) readInfo() *ServerInfo {
	data, err := os.ReadFile(l.infoPath)
	if err != nil {
		return nil
	}
	var info ServerInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil
	}
	return &info
}
