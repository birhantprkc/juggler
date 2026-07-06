//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"os"
	"path/filepath"

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
