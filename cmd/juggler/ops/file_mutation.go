//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/atomicio"
)

// pathLocker serializes content mutations to a given file path. It uses a
// single owner goroutine fed by channels rather than a sync.Mutex, per the
// project's concurrency rule (goroutines + channels; the only sanctioned mutex
// is ycrdtMu in worker/document.go).
//
// Why this is needed: the ops HTTP handler runs each request on its own
// goroutine and builds a fresh, stateless FileOperations per request, so
// two tool calls editing the SAME file run their read-modify-write fully in
// parallel. Both read the same base bytes (a lost update), and — because
// os.WriteFile truncates only at open time and never shrinks on write — a
// shorter write landing after a longer one leaves the longer write's tail in
// place, producing the duplicated trailing content we observed. Serializing the
// whole read→write window per path removes both failure modes.
type pathLocker struct {
	acquire chan pathLockReq
	release chan string
}

type pathLockReq struct {
	path  string
	grant chan struct{}
}

func newPathLocker() *pathLocker {
	l := &pathLocker{
		acquire: make(chan pathLockReq),
		release: make(chan string),
	}
	go l.run()
	return l
}

func (l *pathLocker) run() {
	held := make(map[string]bool)
	waiters := make(map[string][]chan struct{})
	for {
		select {
		case req := <-l.acquire:
			if !held[req.path] {
				held[req.path] = true
				close(req.grant)
			} else {
				waiters[req.path] = append(waiters[req.path], req.grant)
			}
		case path := <-l.release:
			queue := waiters[path]
			if len(queue) > 0 {
				next := queue[0]
				if len(queue) == 1 {
					delete(waiters, path)
				} else {
					waiters[path] = queue[1:]
				}
				// Ownership passes straight to the next waiter — the path stays
				// held, so no other acquire can slip in between.
				close(next)
			} else {
				delete(held, path)
			}
		}
	}
}

// lock blocks until the calling goroutine owns path, then returns an unlock
// function. Hold it across the entire read-modify-write.
func (l *pathLocker) lock(path string) func() {
	grant := make(chan struct{})
	l.acquire <- pathLockReq{path: path, grant: grant}
	<-grant
	return func() { l.release <- path }
}

// fileMutationLock serializes content mutations across all FileOperations
// instances. It is package-level because the ops handler builds a new instance
// per request, so the coordinator can't live on the instance.
var fileMutationLock = newPathLocker()

// openForMutation prepares an existing file for an in-place edit: it sanitises
// path against the scope, takes the per-file mutation lock, requires the target
// to be an existing (non-directory) file, and returns its CRLF-normalized
// content. It is the shared front half of editFile/editFileLines — the exact
// hazard the mutation lock guards is that two edits read the same base bytes and
// one is lost, so every read-modify-write must run under this lock.
//
// On success the caller owns unlock and must `defer unlock()` across the whole
// read→write window. On any error unlock is already called and returned nil, so
// the caller only propagates err.
//
// rawHash is the hex SHA-256 of the file's raw on-disk bytes (before CRLF
// normalization), identical to what loadFile/getFileHash report. It is the
// staleness baseline the edit tools echo back in their dryRun result so the JS
// layer can refuse an edit whose target changed since the model last read it,
// and the value an incoming expectedHash param is compared against so the same
// refusal covers the approval-to-write window.
func (ops *FileOperations) openForMutation(path string) (absPath string, info os.FileInfo, content string, rawHash string, unlock func(), err error) {
	// JS approval is the policy gate; backend sanitises only.
	absPath, err = ops.scope.Sanitize(path)
	if err != nil {
		return "", nil, "", "", nil, fmt.Errorf("invalid path '%s': %w", path, err)
	}

	// Serialize the whole read-modify-write against concurrent edits of the same
	// file: otherwise two edits read the same base bytes and one is lost (see
	// pathLocker).
	unlock = fileMutationLock.lock(absPath)

	info, statErr := os.Stat(absPath)
	if statErr != nil {
		unlock()
		if os.IsNotExist(statErr) {
			return "", nil, "", "", nil, fmt.Errorf("file does not exist: %s. Use write-file action to create new files", path)
		}
		return "", nil, "", "", nil, fmt.Errorf("failed to access file '%s': %w", path, statErr)
	}
	if info.IsDir() {
		unlock()
		return "", nil, "", "", nil, fmt.Errorf("cannot edit directory: %s. Provide a file path instead", path)
	}

	raw, readErr := os.ReadFile(absPath)
	if readErr != nil {
		unlock()
		return "", nil, "", "", nil, fmt.Errorf("failed to read file '%s': %w. Check file permissions", path, readErr)
	}

	hashBytes := sha256.Sum256(raw)
	return absPath, info, strings.ReplaceAll(string(raw), "\r\n", "\n"), hex.EncodeToString(hashBytes[:]), unlock, nil
}

// writeFileAtomic writes data to path via a temp file in the same directory
// followed by an atomic rename. Unlike os.WriteFile (which truncates at open
// time but never shrinks the file on the write itself), this can never leave a
// half-written file or a stale tail from a previous, longer write — the rename
// swaps the whole inode or fails. The temp file lives in the same directory so
// the rename stays on one filesystem (cross-device rename is not atomic).
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".juggler-write-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	if err := atomicio.RobustRename(tmpName, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}
