//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// OSOperations launches host-OS shell integrations: opening a path with its
// default handler and revealing it in the platform file manager. These back
// the right-click "Open file" / "Reveal in Finder" commands. They run on the
// machine hosting the juggler binary (the user's own machine in the normal
// local-first setup), exactly like double-clicking the file in Finder/Explorer.
type OSOperations struct {
	scope PathScope
	// run launches the platform command, defaulting to settleLaunch. A test
	// swaps it to drive the outcomes a GUI handler produces on a machine that
	// has one.
	run func(cmd *exec.Cmd, reveal bool) error
}

// NewOSOperations creates a new OS integration operations handler.
func NewOSOperations(scope PathScope) *OSOperations {
	return &OSOperations{scope: scope}
}

// launchSettle is how long the launcher is given to fail before it is taken to
// have succeeded.
//
// These commands hand a path to something else and exit: `open` returns as soon
// as LaunchServices has accepted it, and refuses with a message when nothing can
// open the file. So a launcher still running after this has not failed — it has
// become the application, whose lifetime is nothing to do with this request.
// A variable so a test does not have to wait it out.
var launchSettle = 2 * time.Second

// Execute dispatches an OS operation by name.
func (o *OSOperations) Execute(_ context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "open":
		return o.launch(params, false)
	case "reveal":
		return o.launch(params, true)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// resolvePath canonicalises the requested path against the working directory
// and confirms it exists. No working-directory containment is enforced: these
// commands are explicit, user-initiated UI actions (a right-click on a path the
// user can already see), and pins legitimately point outside the project root.
func (o *OSOperations) resolvePath(params map[string]any) (string, error) {
	rawPath, _ := params["path"].(string)
	if rawPath == "" {
		return "", fmt.Errorf("missing path parameter")
	}
	abs, err := o.scope.Sanitize(rawPath)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(abs); err != nil {
		return "", fmt.Errorf("path not found: %s", rawPath)
	}
	return abs, nil
}

// launch resolves the path and hands it to the platform open/reveal command,
// reporting whether the launcher took it.
//
// The outcome is worth waiting the moment out for. "Nothing happened" is the
// only thing the user sees when this goes wrong — no window opens, and there is
// nothing on screen to distinguish a file type with no handler, an `xdg-open`
// that is not installed, or a path on a volume that has gone. An error here is
// the only chance to say which.
func (o *OSOperations) launch(params map[string]any, reveal bool) (any, error) {
	abs, err := o.resolvePath(params)
	if err != nil {
		return nil, err
	}

	cmds := newOpenCmds(abs)
	if reveal {
		cmds = newRevealCmds(abs)
	}
	run := o.run
	if run == nil {
		run = settleLaunch
	}

	// Best way first, then whatever else this platform can do. A desktop with no
	// file manager listening on the standard interface still gets its folder
	// opened, and only a path nothing at all would take reports a failure — the
	// last one, which is the plainest way that was tried.
	var refused error
	for _, cmd := range cmds {
		if refused = run(cmd, reveal); refused == nil {
			return map[string]any{"opened": true, "reveal": reveal, "path": abs}, nil
		}
	}
	if refused == nil {
		return nil, fmt.Errorf("no way to %s a path on this platform", map[bool]string{true: "reveal", false: "open"}[reveal])
	}
	return nil, refused
}

// settleLaunch starts the launcher and gives it launchSettle to fail in.
//
// A launcher that exits non-zero inside that window has refused the path, and
// its stderr is the only account of why — so it is captured and carried into the
// error rather than dropped. One that is still running has been accepted and is
// reaped in the background, since by then its exit status belongs to the
// application rather than to this request.
func settleLaunch(cmd *exec.Cmd, reveal bool) error {
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("couldn't run %s: %w", cmd.Path, err)
	}

	// Buffered, so the reaping goroutine finishes whether or not anyone is still
	// listening when the launcher exits.
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		if err == nil || !exitStatusMeansFailure(reveal) {
			return nil
		}
		if said := strings.TrimSpace(stderr.String()); said != "" {
			return fmt.Errorf("%s: %w: %s", cmd.Path, err, said)
		}
		return fmt.Errorf("%s: %w", cmd.Path, err)
	case <-time.After(launchSettle):
		return nil
	}
}
