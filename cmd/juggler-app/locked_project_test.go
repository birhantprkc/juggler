//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

func TestLockedProjectErrorExplainsSafeRecovery(t *testing.T) {
	project := t.TempDir()
	err := newLockedProjectError(project, &core.InstanceInfo{PID: 123, Host: "127.0.0.1", Port: 7777})
	message := err.message()
	for _, want := range []string{
		"could not connect",
		filepath.Join(project, ".juggler", "juggler.lock"),
		"no other Juggler process",
		"delete that file",
		"123",
	} {
		if !strings.Contains(message, want) {
			t.Errorf("recovery message missing %q:\n%s", want, message)
		}
	}
}
