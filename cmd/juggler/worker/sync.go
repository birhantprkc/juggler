//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
)

// WorkerMessage is the format for messages to/from Go worker via WebSocket.
type WorkerMessage struct {
	Type           string          `json:"type"`           // "worker-message"
	ConversationID string          `json:"conversationId"` // Target conversation
	WorkerMsgType  string          `json:"workerMsgType"`  // Actual worker message type
	Payload        json.RawMessage `json:"payload"`        // Message payload
}

// FormatWorkerMessage creates a worker message for sending to browser.
func FormatWorkerMessage(conversationID string, workerMsg []byte) []byte {
	// Parse the worker message to get its type
	var generic struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(workerMsg, &generic); err != nil {
		return nil
	}

	msg := WorkerMessage{
		Type:           "worker-message",
		ConversationID: conversationID,
		WorkerMsgType:  generic.Type,
		Payload:        workerMsg,
	}

	data, _ := json.Marshal(msg)
	return data
}
