//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestBackgroundTaskSnapshotWire pins the JSON a snapshot marshals to. The
// worker decodes this payload by name on the far side of the manager and stores
// the whole object verbatim as the tool action's displayData, so the key set is
// a contract with the UI, not an implementation detail — and it has to survive
// the fields being carried in an embedded struct.
func TestBackgroundTaskSnapshotWire(t *testing.T) {
	full := BackgroundTaskSnapshot{
		TaskID:    "task-1",
		ConvID:    "conv-1",
		ToolUseID: "tool-1",
		TaskOutputState: TaskOutputState{
			Status:          "completed",
			Output:          "hello",
			ExitCode:        3,
			Error:           "boom",
			OutputFile:      "/tmp/out.txt",
			OutputBytes:     1234,
			OutputTruncated: true,
		},
	}
	want := map[string]any{
		"taskId": "task-1", "toolUseId": "tool-1",
		"status": "completed", "output": "hello", "exitCode": float64(3),
		"error": "boom", "outputFile": "/tmp/out.txt",
		"outputBytes": float64(1234), "truncated": true,
	}
	if got := marshalToMap(t, full); !reflect.DeepEqual(got, want) {
		t.Errorf("populated snapshot marshalled to %v, want %v", got, want)
	}

	// The optional tail drops out, and ConvID — which names the conversation the
	// observer routes to — never crosses the wire at all.
	minimal := BackgroundTaskSnapshot{
		TaskID: "task-2", ConvID: "conv-2", ToolUseID: "tool-2",
		TaskOutputState: TaskOutputState{Status: "running"},
	}
	wantMinimal := map[string]any{
		"taskId": "task-2", "toolUseId": "tool-2",
		"status": "running", "output": "", "exitCode": float64(0),
	}
	if got := marshalToMap(t, minimal); !reflect.DeepEqual(got, wantMinimal) {
		t.Errorf("minimal snapshot marshalled to %v, want %v", got, wantMinimal)
	}
}

func marshalToMap(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

// TestTaskStateCarriesOutputState checks that the read accessor hands back the
// registry's own state rather than a hand-copied subset of it: a field added to
// TaskOutputState must reach a TaskState caller without anyone remembering to
// widen a copy.
func TestTaskStateCarriesOutputState(t *testing.T) {
	var snap TaskSnapshot
	field, ok := reflect.TypeOf(snap).FieldByName("TaskOutputState")
	if !ok || !field.Anonymous {
		t.Fatalf("TaskSnapshot must embed TaskOutputState, got fields %v", reflect.TypeOf(snap))
	}
}
