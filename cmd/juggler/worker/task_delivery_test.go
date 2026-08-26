//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTaskDeliveryInjectsStampedMonitorMessage(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	payload, err := json.Marshal(injectThreadMessageMsg{
		Text:   deliveryHeader("monitor: build") + "\nBUILD_FAILED",
		TaskID: "bg-test-1",
		Label:  "monitor: build",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	w.currentRun().handleInjectThreadMessage(payload)

	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("expected one injected item, got %d", len(items))
	}
	got := items[0]
	if got.Type != ItemTypeUser {
		t.Fatalf("expected injected user item, got %q", got.Type)
	}
	if !strings.Contains(got.Content, "BUILD_FAILED") {
		t.Fatalf("injected content missing output: %q", got.Content)
	}
	if got.TaskSource == nil {
		t.Fatal("expected injected output to carry taskSource")
	}
	if got.TaskSource.TaskID != "bg-test-1" || got.TaskSource.Label != "monitor: build" {
		t.Fatalf("unexpected taskSource: %+v", got.TaskSource)
	}
}

func TestTaskDeliveryTerminalTextIsUnambiguous(t *testing.T) {
	text := deliveryHeader("monitor: build") + "\n" + "background task ended (status completed, exit code 0)"
	if !strings.Contains(text, "background task ended") {
		t.Fatalf("terminal text should say background task ended: %q", text)
	}
	if strings.Contains(text, "\nexited (") {
		t.Fatalf("terminal text should not use ambiguous exited wording: %q", text)
	}
}
