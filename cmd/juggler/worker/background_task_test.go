//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"reflect"
	"testing"

	"juggler/cmd/juggler/ops"
)

// TestBackgroundTaskSnapshotIsOpsType asserts type IDENTITY rather than field
// equality. A snapshot that crosses from the shell registry to a tool action is
// one shape, and the failure mode worth catching is someone re-declaring that
// shape here — which a field-by-field comparison would wave through.
func TestBackgroundTaskSnapshotIsOpsType(t *testing.T) {
	got := reflect.TypeOf(BackgroundTaskSnapshot{})
	want := reflect.TypeOf(ops.BackgroundTaskSnapshot{})
	if got != want {
		t.Fatalf("worker.BackgroundTaskSnapshot must be the ops type, got %s want %s", got, want)
	}
}
