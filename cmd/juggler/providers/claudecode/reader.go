//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Continuous stdout reader for one persistent CLI session.
//
// A single long-lived goroutine owns the scanner channel (s.lines) for the
// lifetime of the live CLI. It demultiplexes the two kinds of envelope the
// CLI multiplexes on stdout:
//
//   - control frames (control_request / control_response /
//     control_cancel_request) are routed straight to the control-protocol
//     actor, which is safe to call concurrently with the worker goroutine
//     (control_protocol.go). This is what lets the
//     CLI's control traffic — including the initialize handshake's response
//     and, later, autonomous-turn tool calls — be handled even when no turn
//     is being actively read.
//
//   - content lines (system / stream_event / result) are forwarded to
//     s.content, which readUntilPauseOrComplete consumes. Lines are forwarded
//     one at a time, in order.
//
// The reader is the SOLE consumer of s.lines and the SOLE closer of
// s.content. It exits when s.lines closes (CLI exit) or s.readerStop is
// closed (teardown), and closes s.content on the way out so the turn
// consumer observes end-of-stream.

package claudecode

import (
	"encoding/json"

	"juggler/internal/jlog"
)

// startStreamReader launches the continuous reader over s. The session must
// already have its live-CLI channels (lines/content/readerStop/readerDone)
// populated by spawnCLIPipes and its control protocol attached, so the reader
// can route control frames from the first line. Channels are captured into
// locals up front: the goroutine never touches s again, so teardown nil-ing
// the fields cannot race with it.
func startStreamReader(s *activeSession) {
	lines := s.live.lines
	content := s.live.content
	stop := s.live.readerStop
	done := s.live.readerDone
	ctrl := s.live.control
	go func() {
		// done closes after content (LIFO): a teardown waiting on readerDone
		// is thus guaranteed that content is already closed when it returns.
		defer close(done)
		defer close(content)
		for {
			select {
			case <-stop:
				return
			case line, ok := <-lines:
				if !ok {
					return // scanner closed s.lines: CLI exited.
				}
				if line == "" {
					continue
				}
				// One unmarshal serves both demux roles: route control frames to
				// the actor, and — for a content line that PAUSES the turn on
				// tool_use — latch that the current tool round's emission is
				// complete (noteToolUsePause), so the NEXT round's first park
				// opens a new generation. A line that doesn't parse is treated as
				// content (the consumer skips it).
				var msg StreamMessage
				parsed := json.Unmarshal([]byte(line), &msg) == nil
				if parsed && dispatchControlFrame(ctrl, &msg) {
					continue
				}
				if parsed && ctrl != nil && isToolUsePause(&msg) {
					ctrl.noteToolUsePause()
				}
				select {
				case content <- line:
				case <-stop:
					return
				}
			}
		}
	}()
}

// isToolUsePause reports whether a parsed stream line is the message_delta that
// pauses the turn on stop_reason=tool_use — the signal that the model has just
// issued a new batch of tool calls, delimiting one tool round from the next.
func isToolUsePause(msg *StreamMessage) bool {
	return msg.Type == "stream_event" && msg.Event != nil &&
		msg.Event.Type == "message_delta" && msg.Event.Delta != nil &&
		msg.Event.Delta.StopReason == "tool_use"
}

// dispatchControlFrame routes an already-parsed control envelope to the
// control-protocol actor, returning true if the message was a control frame
// (and thus consumed). Content frames return false so the caller forwards them
// to the turn consumer.
func dispatchControlFrame(ctrl *controlProtocol, msg *StreamMessage) bool {
	if ctrl == nil {
		return false
	}
	switch msg.Type {
	case "control_request":
		// CLI asking us to do something (typically: invoke an MCP tool via
		// mcp_message). The actor records/answers it; tools/call responses
		// are emitted later when the worker hands us the result.
		if err := ctrl.handleControlRequest(msg); err != nil {
			jlog.Debug("reader: control_request dispatch error: %v", err)
		}
		return true
	case "control_response":
		// CLI replying to an outbound control_request we sent (today only
		// initialize). The actor matches it to the parked sender, if any.
		ctrl.handleControlResponse(msg)
		return true
	case "control_cancel_request":
		// CLI cancelling a pending outbound control_request. We don't emit
		// cancellable outbound requests today; logged for forensics.
		jlog.Debug("reader: control_cancel_request id=%s — no-op", msg.RequestID)
		return true
	}
	return false
}
