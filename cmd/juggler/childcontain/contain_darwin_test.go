//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package childcontain_test

import (
	"os/exec"
	"syscall"
	"testing"

	"juggler/cmd/juggler/childcontain"
)

func TestPrepare_SetsProcessGroup(t *testing.T) {
	cmd := exec.Command("true")
	childcontain.Prepare(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("Prepare did not set SysProcAttr")
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Fatal("Prepare did not set Setpgid")
	}
}

func TestPrepare_PreservesExistingSysProcAttr(t *testing.T) {
	cmd := exec.Command("true")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	childcontain.Prepare(cmd)

	if !cmd.SysProcAttr.Setsid {
		t.Error("Prepare clobbered pre-existing SysProcAttr.Setsid")
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Error("Prepare did not set Setpgid")
	}
}
