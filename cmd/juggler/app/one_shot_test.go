//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// `juggler run`'s command line and its trail on disk.
//
// The command line matters because the run is unattended: a prompt lost to
// quoting, or a project silently resolved to somewhere else, produces a run that
// looks like it worked. The trail matters because a run that did NOT work is the
// one whose conversation somebody needs to open — including when it timed out,
// which is exactly when the engine never said which conversation it made.

func TestRunParsesItsCommandLine(t *testing.T) {
	dir := t.TempDir()
	opts, code := parseOneShotFlags([]string{"--project", dir, "--timeout", "90s", "--strategy", "default", "--json", "fix", "the", "bug"})
	if opts == nil {
		t.Fatalf("parse failed with code %d", code)
	}
	// The prompt is every remaining word, so an unquoted sentence still arrives
	// whole rather than as its first word.
	if opts.prompt != "fix the bug" {
		t.Errorf("prompt = %q, want %q", opts.prompt, "fix the bug")
	}
	if opts.project != dir {
		t.Errorf("project = %q, want %q", opts.project, dir)
	}
	if opts.timeout != 90*time.Second {
		t.Errorf("timeout = %v, want 90s", opts.timeout)
	}
	if opts.strategy != "default" {
		t.Errorf("strategy = %q, want %q", opts.strategy, "default")
	}
	if !opts.asJSON {
		t.Error("--json was not honoured")
	}
	if opts.name == "" {
		t.Error("the run has no name, so its conversation could not be found again")
	}
}

func TestRunDefaultsToHereAndToYolo(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	opts, code := parseOneShotFlags([]string{"do a thing"})
	if opts == nil {
		t.Fatalf("parse failed with code %d", code)
	}
	// Resolved explicitly rather than left to the ordinary startup default,
	// which asks whether a terminal is attached — and for an unattended run
	// there is not one, which would leave the run with no project at all.
	if opts.project != wd {
		t.Errorf("project = %q, want the working directory %q", opts.project, wd)
	}
	// Anything else parks on its first tool with nobody to approve it.
	if opts.strategy != "yolo" {
		t.Errorf("strategy = %q, want %q", opts.strategy, "yolo")
	}
	if opts.timeout != defaultRunTimeout {
		t.Errorf("timeout = %v, want %v", opts.timeout, defaultRunTimeout)
	}
}

func TestRunRefusesAnEmptyPrompt(t *testing.T) {
	for _, args := range [][]string{{}, {"   "}} {
		opts, code := parseOneShotFlags(args)
		if opts != nil {
			t.Errorf("parseOneShotFlags(%q) accepted a run with nothing to run", args)
		}
		if code != exitRunUsage {
			t.Errorf("parseOneShotFlags(%q) exit code = %d, want %d", args, code, exitRunUsage)
		}
	}
}

func TestRunFindsItsConversationByNameWhenTheIDIsUnknown(t *testing.T) {
	project := t.TempDir()
	jugglerDir := filepath.Join(project, ".juggler")
	want := filepath.Join(jugglerDir, "Run 2026-08-24 19-56-57--conv_abcdefghi")
	other := filepath.Join(jugglerDir, "Something else--conv_zzzzzzzzz")
	for _, dir := range []string{want, other} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	a := &App{projectPath: project}

	// A run that timed out never learned its conversation's id, and its
	// trajectory is the whole reason anyone looks. The name is unique per run,
	// which is what makes it answerable anyway.
	if got := a.conversationDir("Run 2026-08-24 19-56-57", ""); got != want {
		t.Errorf("by name: got %q, want %q", got, want)
	}
	// With an id, that is the exact answer.
	if got := a.conversationDir("Run 2026-08-24 19-56-57", "conv_zzzzzzzzz"); got != other {
		t.Errorf("by id: got %q, want %q", got, other)
	}
	if got := a.conversationDir("Run that never happened", ""); got != "" {
		t.Errorf("invented a directory for a run with none: %q", got)
	}
}
