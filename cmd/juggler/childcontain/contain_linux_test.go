//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build linux

package childcontain_test

import (
	"os/exec"
	"syscall"
	"testing"

	"juggler/cmd/juggler/childcontain"
)

// TestPrepare_SetsPdeathsig verifies that Prepare sets Pdeathsig = SIGTERM on
// the cmd's SysProcAttr, which is the Linux mechanism for death propagation.
func TestPrepare_SetsPdeathsig(t *testing.T) {
	cmd := exec.Command("true")
	childcontain.Prepare(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("Prepare did not set SysProcAttr")
	}
	if cmd.SysProcAttr.Pdeathsig != syscall.SIGTERM {
		t.Fatalf("Pdeathsig = %v, want SIGTERM (%v)", cmd.SysProcAttr.Pdeathsig, syscall.SIGTERM)
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Fatal("Prepare did not set Setpgid")
	}
}

// TestPrepare_PreservesExistingSysProcAttr verifies that Prepare does not
// overwrite other SysProcAttr fields the caller may have set.
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
	if cmd.SysProcAttr.Pdeathsig != syscall.SIGTERM {
		t.Errorf("Pdeathsig = %v, want SIGTERM", cmd.SysProcAttr.Pdeathsig)
	}
}
