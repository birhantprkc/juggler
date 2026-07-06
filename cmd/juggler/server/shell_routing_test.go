//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// newTestServerStateWithProject is newTestServerState plus a real
// SessionManager rooted at a temp dir, so processShellRequest (which reads
// s.SessionManager().GetProjectPath() for the command cwd) has a valid project.
func newTestServerStateWithProject(t *testing.T) *Server {
	t.Helper()
	s := &Server{hub: newClientHub()}
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s.projectState.Store(&projectState{sessionManager: mgr, viewers: newViewerGroup()})
	return s
}

// awaitShellDone drains a test WSClient's send channel looking for the
// shell-output `done` chunk for shellID. processShellRequest enqueues every
// chunk before returning, so this only ever blocks on the (generous) deadline
// when the chunk genuinely never arrives.
func awaitShellDone(t *testing.T, c *WSClient, shellID string) bool {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case msg := <-c.send:
			m, ok := msg.json.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "shell-output" && m["shellId"] == shellID && m["done"] == true {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

// TestProcessShellRequest_DeliversToRequesterNotViewerGroup is the regression
// guard for the bash-wedge bug. shell-output is consumed solely by the engine's
// shellExecuteStreaming, which resolves the bash tool on the `done` chunk. The
// chunk must reach the client that REQUESTED the shell — not the project's
// viewer group — because the persistent engine is not a reliable viewer-group
// member (it never reloads to re-join after a SwitchProject).
func TestProcessShellRequest_DeliversToRequesterNotViewerGroup(t *testing.T) {
	s := newTestServerStateWithProject(t)

	// The requester (engine) is deliberately NOT a viewer-group member.
	engine := testWSClient("engine")

	// A viewer IS in the group — proves we are routing to the requester, not
	// broadcasting to the group.
	viewer := testWSClient("viewer")
	s.joinViewerGroup(viewer)

	complete := make(chan string, 1)
	s.processShellRequest(context.Background(),
		ShellStartRequest{ShellID: "sh-test", Command: "echo hi"}, engine, complete)

	if !awaitShellDone(t, engine, "sh-test") {
		t.Fatal("engine requester never received shell-output done chunk")
	}

	// The viewer-group member must NOT receive shell-output (it is no longer on
	// the shell path; live output rides the separate engine-bridge channel).
	select {
	case msg := <-viewer.send:
		t.Fatalf("viewer-group member unexpectedly received a message on the shell path: %+v", msg)
	default:
	}
}

// TestProcessShellRequest_SurvivesViewerGroupSwap reproduces the exact failure:
// the engine joined the original project's viewer group, then a SwitchProject
// replaced that group with a fresh one (and stopped the old one) without the
// engine re-joining. bash must still complete. Under the old viewer-group
// broadcast this stranded the engine (output went to the new group, which the
// engine was never in); read/grep over HTTP and worker-messages were unaffected,
// so only bash wedged.
func TestProcessShellRequest_SurvivesViewerGroupSwap(t *testing.T) {
	s := newTestServerStateWithProject(t)

	engine := testWSClient("engine")
	s.joinViewerGroup(engine) // engine joined the ORIGINAL group

	// Simulate SwitchProject: a brand-new viewer group replaces the old one,
	// the old one is stopped, and the persistent engine never re-joins.
	old := s.projectState.Load()
	newMgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(newMgr.Shutdown)
	s.projectState.Store(&projectState{sessionManager: newMgr, viewers: newViewerGroup()})
	old.viewers.stop()

	complete := make(chan string, 1)
	s.processShellRequest(context.Background(),
		ShellStartRequest{ShellID: "sh2", Command: "echo hi"}, engine, complete)

	if !awaitShellDone(t, engine, "sh2") {
		t.Fatal("engine never received shell-output after viewer-group swap (bash-wedge regression)")
	}
}
