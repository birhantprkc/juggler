//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server"
)

// `juggler run "<prompt>"` — one prompt, unattended, exiting with a status.
//
// It is the same server every other launch boots. What differs is that nobody
// is watching it: there is no window, no keyboard, and nothing to answer a
// question with. So the run configures the conversation so that nothing needs
// answering (see engine-one-shot.js), and everything that could still wait
// forever is bounded here instead — the engine connecting, the turn finishing,
// and the process exiting once it has.
//
// stdout carries the answer and nothing else, so a caller can pipe it. Every
// other word, including the address line the server normally prints there, goes
// to stderr.

// Exit codes. A caller needs to tell these apart without reading prose, because
// the difference between "the model answered and was wrong" and "something
// wanted a human" is the difference between a result and a broken harness.
const (
	// exitRunCompleted: the turn ran to its end.
	exitRunCompleted = 0
	// exitRunFailed: the turn errored, or never started.
	exitRunFailed = 1
	// exitRunUsage: the command line was wrong. Matches `juggler serve`.
	exitRunUsage = 2
	// exitRunParked: a tool wanted a human, and there wasn't one.
	exitRunParked = 3
	// exitRunTimeout: the run outlived its deadline and was abandoned.
	exitRunTimeout = 4
)

// defaultRunTimeout bounds a run that names no deadline of its own. Long enough
// for real work on a real repository; short enough that a wedged run in a
// container is not still there tomorrow.
const defaultRunTimeout = 30 * time.Minute

// oneShotOptions is a parsed `juggler run` invocation.
type oneShotOptions struct {
	prompt   string
	project  string
	strategy string
	timeout  time.Duration
	asJSON   bool
	// name is the conversation's name, and therefore how its directory is found
	// again — including when the run times out and the engine never says which
	// conversation it made. It is stamped with the start time so consecutive
	// runs in one project stay apart.
	name string
}

// parseOneShotFlags parses `juggler run`'s own flag set. It returns nil options
// and an exit code when the command line is unusable or has already been
// answered (--help).
func parseOneShotFlags(args []string) (*oneShotOptions, int) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	project := fs.String("project", "", "Project folder to work in (defaults to the current directory)")
	strategy := fs.String("strategy", "yolo", "Strategy to run under")
	timeout := fs.Duration("timeout", defaultRunTimeout, "Give up if the run takes longer than this")
	asJSON := fs.Bool("json", false, "Print the whole outcome as JSON instead of just the answer")
	fs.Usage = func() {
		out := fs.Output()
		fmt.Fprintf(out, "Juggler — run one prompt to completion and exit.\n\nUsage: %s run [options] <prompt>\n\n"+
			"Reads the prompt from stdin when it is `-`. Options come before the prompt.\n\nOptions:\n",
			filepath.Base(os.Args[0]))
		fs.PrintDefaults()
		fmt.Fprintf(out, "\nExit codes: %d finished, %d failed, %d bad usage, %d a tool wanted a human, %d timed out.\n",
			exitRunCompleted, exitRunFailed, exitRunUsage, exitRunParked, exitRunTimeout)
	}
	if err := fs.Parse(args); err != nil {
		// ContinueOnError has already printed the error and the usage. Asking
		// for that usage is not a failure to report as one.
		if errors.Is(err, flag.ErrHelp) {
			return nil, exitRunCompleted
		}
		return nil, exitRunUsage
	}

	prompt := strings.Join(fs.Args(), " ")
	if strings.TrimSpace(prompt) == "-" {
		piped, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Couldn't read the prompt from stdin: %v\n", err)
			return nil, exitRunUsage
		}
		prompt = string(piped)
	}
	if strings.TrimSpace(prompt) == "" {
		fmt.Fprintln(os.Stderr, "There is no prompt to run.")
		fs.Usage()
		return nil, exitRunUsage
	}

	// A run with no --project means "here". Resolved to an explicit path rather
	// than left to the ordinary startup default, which asks whether there is a
	// terminal attached — and for an unattended run there is not.
	dir := *project
	if dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Couldn't work out which folder to run in: %v\n", err)
			return nil, exitRunUsage
		}
		dir = wd
	}

	return &oneShotOptions{
		prompt:   prompt,
		project:  dir,
		strategy: *strategy,
		timeout:  *timeout,
		asJSON:   *asJSON,
		name:     "Run " + time.Now().Format("2006-01-02 15-04-05"),
	}, exitRunCompleted
}

// startupOut is where startup chatter goes. A run's stdout carries its answer
// and nothing else, so that everything a caller pipes came from the model —
// which puts the address line and the progress notes on stderr, still said, just
// not in the middle of the answer.
func (a *App) startupOut() io.Writer {
	if a.flags.oneShot != nil {
		return os.Stderr
	}
	return os.Stdout
}

// appFlags builds the launch these options describe: headless, in the resolved
// project, with the run itself carried on the flags so the phase list picks it
// up.
func (o *oneShotOptions) appFlags(hasTerminal bool) appFlags {
	return appFlags{
		project:     o.project,
		projectSet:  true,
		hasTerminal: hasTerminal,
		oneShot:     o,
	}
}

// startOneShot is the startup phase that drives the run. It returns at once:
// the run happens on its own goroutine, so the app reaches its wait loop and
// the engine host it boots there is the thing the run is waiting for.
func (a *App) startOneShot() error {
	opts := a.flags.oneShot
	if opts == nil {
		return nil
	}
	go func() {
		code, result := a.awaitOneShot(opts)
		a.reportOneShot(opts, code, result)
		a.exitCode.Store(int32(code))
		// Exit through the server's own shutdown request, so this unwinds by the
		// same path as every other exit — which is what shuts the server down,
		// closes the conversations and reaps the provider subprocesses.
		a.server.RequestShutdown()
	}()
	return nil
}

// awaitOneShot dispatches the run and waits for it, and owns every deadline in
// the process. Returns the exit code and whatever the engine managed to report.
func (a *App) awaitOneShot(opts *oneShotOptions) (int, server.OneShotResult) {
	failed := func(format string, args ...any) (int, server.OneShotResult) {
		return exitRunFailed, server.OneShotResult{Status: server.OneShotFailed, ErrorText: fmt.Sprintf(format, args...)}
	}

	if a.projectPath == "" {
		return failed("there is no project to run in")
	}
	if !a.server.WaitForEngineConnected(engineConnectTimeout) {
		return failed("the engine did not start within %v, so there is nothing to run the prompt", engineConnectTimeout)
	}

	replies, err := a.server.StartOneShot(server.OneShotRequest{
		Prompt:     opts.prompt,
		StrategyID: opts.strategy,
		Name:       opts.name,
		Timeout:    opts.timeout,
	})
	if err != nil {
		return failed("%v", err)
	}

	select {
	case result := <-replies:
		switch result.Status {
		case server.OneShotCompleted:
			return exitRunCompleted, result
		case server.OneShotParked:
			return exitRunParked, result
		default:
			return exitRunFailed, result
		}
	case <-time.After(opts.timeout):
		a.server.CancelOneShot()
		return exitRunTimeout, server.OneShotResult{
			Status:    "timeout",
			ErrorText: fmt.Sprintf("the run did not finish within %v", opts.timeout),
		}
	case <-a.server.ShutdownChan():
		a.server.CancelOneShot()
		return failed("the server shut down before the run finished")
	}
}

// reportOneShot writes the outcome: the answer on stdout, the account of it on
// stderr. Where the conversation ended up is on stderr too, and on every exit
// path — a run that failed or timed out is the one whose trajectory somebody
// wants to read.
func (a *App) reportOneShot(opts *oneShotOptions, code int, result server.OneShotResult) {
	dir := a.conversationDir(opts.name, result.ConversationID)

	if opts.asJSON {
		payload := map[string]any{
			"status":          result.Status,
			"exitCode":        code,
			"conversationId":  result.ConversationID,
			"conversationDir": dir,
			"turns":           result.Turns,
			"finalText":       result.FinalText,
			"parkedTool":      result.ParkedTool,
			"errorText":       result.ErrorText,
		}
		encoded, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Couldn't render the outcome as JSON: %v\n", err)
			return
		}
		fmt.Println(string(encoded))
		return
	}

	if result.FinalText != "" {
		fmt.Println(result.FinalText)
	}
	switch code {
	case exitRunCompleted:
	case exitRunParked:
		if result.ParkedTool != "" {
			fmt.Fprintf(os.Stderr, "Stopped: %s wanted an answer, and there is nobody here to give one.\n", result.ParkedTool)
		} else {
			fmt.Fprintln(os.Stderr, "Stopped: a tool wanted an answer, and there is nobody here to give one.")
		}
	case exitRunTimeout:
		fmt.Fprintf(os.Stderr, "%s\n", capitalise(result.ErrorText))
	default:
		fmt.Fprintf(os.Stderr, "Couldn't finish the run: %s\n", result.ErrorText)
	}
	if dir != "" && code != exitRunCompleted {
		fmt.Fprintf(os.Stderr, "The conversation is in %s\n", dir)
	}
}

// conversationDir locates the run's conversation folder, from which its
// transaction blobs — the only record of what actually went to the model — can
// be read. The id is the exact answer when the engine got far enough to report
// one; the name is the fallback, which is why each run's name is unique.
func (a *App) conversationDir(name, id string) string {
	index, err := core.ScanConvDirs(filepath.Join(a.projectPath, ".juggler"))
	if err != nil {
		return ""
	}
	if dir, ok := index.ByID[id]; ok && id != "" {
		return dir
	}
	for convID, convName := range index.Names {
		if convName == name {
			return index.ByID[convID]
		}
	}
	return ""
}

// capitalise upper-cases the first letter of a sentence assembled from a phrase
// written to read mid-sentence.
func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
