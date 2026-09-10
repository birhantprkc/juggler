//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"testing"
	"time"
)

// TestRegistryAnswersAnUnrecognisedOp pins the property that makes an
// unhandled op kind a visible fault rather than a silent one: every accessor
// here sends a request and then waits for the reply, so a kind the registry
// does not act on wedges its caller for the life of the process.
func TestRegistryAnswersAnUnrecognisedOp(t *testing.T) {
	resp := make(chan registryResp, 1)
	registryCh <- registryOp{kind: registryOpKind(-1), resp: resp}

	select {
	case <-resp:
	case <-time.After(5 * time.Second):
		t.Fatal("registry never answered an unrecognised op kind; a caller waiting on it would wait forever")
	}
}
