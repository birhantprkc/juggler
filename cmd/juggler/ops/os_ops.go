//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"os"
	"os/exec"
)

// OSOperations launches host-OS shell integrations: opening a path with its
// default handler and revealing it in the platform file manager. These back
// the right-click "Open file" / "Reveal in Finder" commands. They run on the
// machine hosting the juggler binary (the user's own machine in the normal
// local-first setup), exactly like double-clicking the file in Finder/Explorer.
type OSOperations struct {
	scope PathScope
}

// NewOSOperations creates a new OS integration operations handler.
func NewOSOperations(scope PathScope) *OSOperations {
	return &OSOperations{scope: scope}
}

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

// launch resolves the path and hands it to the platform open/reveal command.
// The child process is detached (we reap it in the background) so the op
// returns immediately without blocking on the launched application.
func (o *OSOperations) launch(params map[string]any, reveal bool) (any, error) {
	abs, err := o.resolvePath(params)
	if err != nil {
		return nil, err
	}

	var cmd *exec.Cmd
	if reveal {
		cmd = newRevealCmd(abs)
	} else {
		cmd = newOpenCmd(abs)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to launch: %w", err)
	}
	// Reap asynchronously so the launcher process isn't left as a zombie; we
	// don't care about its exit status (the GUI handler owns the window now).
	go func() { _ = cmd.Wait() }()

	return map[string]any{"opened": true, "reveal": reveal, "path": abs}, nil
}
