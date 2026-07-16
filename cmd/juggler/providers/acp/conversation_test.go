//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package acp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// newConvHarness builds a conversation with a live session pre-installed over
// pipes, bypassing spawn+handshake so a turn can be driven deterministically.
func newConvHarness(t *testing.T) (*conversation, *fakeAgentPipes) {
	t.Helper()
	fa := newFakeAgent()
	conv := &conversation{
		client:   &Client{workingDir: "/tmp"},
		convID:   "c1",
		approver: defaultApprover{},
		initLock: newLock(),
	}
	tr := newTransport(fa.clientStdin, fa.clientStdout, nil, nil)
	tr.start(conv)
	conv.sess.Store(&session{rpc: tr, sessionID: "s1"})
	t.Cleanup(func() {
		tr.close()
		fa.stop()
	})
	return conv, fa
}

type chunkCollector struct {
	guard  lock
	chunks []provider.StreamChunk
}

func newChunkCollector() *chunkCollector { return &chunkCollector{guard: newLock()} }

func (c *chunkCollector) cb(chunk provider.StreamChunk) (*provider.ToolResult, error) {
	c.guard.acquire()
	c.chunks = append(c.chunks, chunk)
	c.guard.release()
	return nil, nil
}

func (c *chunkCollector) textAndThinking() (text, thinking string) {
	c.guard.acquire()
	defer c.guard.release()
	var tb, th strings.Builder
	for _, ch := range c.chunks {
		switch ch.Type {
		case provider.ContentBlockTypeText:
			tb.WriteString(ch.Content)
		case provider.ContentBlockTypeThinking:
			th.WriteString(ch.Content)
		}
	}
	return tb.String(), th.String()
}

type submitResult struct {
	res *provider.StreamResult
	err error
}

func userReq(text string) provider.MessageRequest {
	return provider.MessageRequest{Messages: []provider.Message{{Type: "user", Content: text}}}
}

func TestConversationHappyPath(t *testing.T) {
	conv, fa := newConvHarness(t)
	col := newChunkCollector()

	resCh := make(chan submitResult, 1)
	go func() {
		r, err := conv.Submit(context.Background(), userReq("hi there"), col.cb)
		resCh <- submitResult{r, err}
	}()

	prompt := fa.readMsg(t)
	if prompt.Method != "session/prompt" {
		t.Fatalf("method = %q, want session/prompt", prompt.Method)
	}
	var pp promptParams
	if err := json.Unmarshal(prompt.Params, &pp); err != nil {
		t.Fatalf("decode prompt params: %v", err)
	}
	if pp.SessionID != "s1" {
		t.Fatalf("sessionId = %q, want s1", pp.SessionID)
	}
	if len(pp.Prompt) != 1 || pp.Prompt[0].Text != "hi there" {
		t.Fatalf("prompt = %+v, want single text 'hi there'", pp.Prompt)
	}

	fa.writeNotification(t, "session/update", sessionUpdateParams{SessionID: "s1", Update: sessionUpdate{SessionUpdate: updAgentThoughtChunk, Content: &updateContent{Type: "text", Text: "let me think"}}})
	fa.writeNotification(t, "session/update", sessionUpdateParams{SessionID: "s1", Update: sessionUpdate{SessionUpdate: updAgentMessageChunk, Content: &updateContent{Type: "text", Text: "Hello "}}})
	fa.writeNotification(t, "session/update", sessionUpdateParams{SessionID: "s1", Update: sessionUpdate{SessionUpdate: updAgentMessageChunk, Content: &updateContent{Type: "text", Text: "world"}}})
	fa.writeResult(t, prompt.ID, promptResult{StopReason: "end_turn"})

	select {
	case sr := <-resCh:
		if sr.err != nil {
			t.Fatalf("submit error: %v", sr.err)
		}
		if sr.res.StopReason != "end_turn" {
			t.Fatalf("stopReason = %q, want end_turn", sr.res.StopReason)
		}
		if sr.res.OutputTokens == 0 {
			t.Fatalf("OutputTokens = 0, want > 0 (estimated)")
		}
		text, thinking := col.textAndThinking()
		if text != "Hello world" {
			t.Fatalf("text = %q, want %q", text, "Hello world")
		}
		if thinking != "let me think" {
			t.Fatalf("thinking = %q, want %q", thinking, "let me think")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("submit did not return")
	}
}

func TestConversationPermissionBridge(t *testing.T) {
	conv, fa := newConvHarness(t)
	col := newChunkCollector()

	resCh := make(chan submitResult, 1)
	go func() {
		r, err := conv.Submit(context.Background(), userReq("do a thing"), col.cb)
		resCh <- submitResult{r, err}
	}()

	prompt := fa.readMsg(t)

	// Agent asks the client to approve a tool.
	fa.writeRequest(t, rawID(100), "session/request_permission", requestPermissionParams{
		SessionID: "s1",
		ToolCall:  json.RawMessage(`{"toolCallId":"t1"}`),
		Options: []permissionOption{
			{OptionID: "allow", Kind: kindAllowOnce},
			{OptionID: "deny", Kind: "reject_once"},
		},
	})

	// The client's approval response is the next line it writes.
	resp := fa.readMsg(t)
	if string(resp.ID) != "100" {
		t.Fatalf("response id = %s, want 100", resp.ID)
	}
	var pr permissionResponse
	if err := json.Unmarshal(resp.Result, &pr); err != nil {
		t.Fatalf("decode permission response: %v", err)
	}
	if pr.Outcome.Outcome != "selected" || pr.Outcome.OptionID != "allow" {
		t.Fatalf("outcome = %+v, want selected/allow", pr.Outcome)
	}

	fa.writeResult(t, prompt.ID, promptResult{StopReason: "end_turn"})

	select {
	case sr := <-resCh:
		if sr.err != nil {
			t.Fatalf("submit error: %v", sr.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("submit did not return after permission")
	}
}

func TestConversationDeclinesFSCapability(t *testing.T) {
	conv, fa := newConvHarness(t)
	col := newChunkCollector()

	resCh := make(chan submitResult, 1)
	go func() {
		r, err := conv.Submit(context.Background(), userReq("read a file"), col.cb)
		resCh <- submitResult{r, err}
	}()

	prompt := fa.readMsg(t)

	// Agent tries a delegated fs read — MVP declines it.
	fa.writeRequest(t, rawID(7), "fs/read_text_file", map[string]string{"path": "/etc/hosts"})
	resp := fa.readMsg(t)
	if resp.Error == nil || resp.Error.Code != rpcCodeMethodNotFound {
		t.Fatalf("fs/read_text_file response = %+v, want method-not-found error", resp)
	}

	fa.writeResult(t, prompt.ID, promptResult{StopReason: "end_turn"})
	<-resCh
}

func TestConversationCancelPreservesSession(t *testing.T) {
	conv, fa := newConvHarness(t)
	col := newChunkCollector()

	resCh := make(chan submitResult, 1)
	go func() {
		r, err := conv.Submit(context.Background(), userReq("long task"), col.cb)
		resCh <- submitResult{r, err}
	}()

	prompt := fa.readMsg(t)

	conv.Cancel()

	cancelMsg := fa.readMsg(t)
	if cancelMsg.Method != "session/cancel" {
		t.Fatalf("method = %q, want session/cancel", cancelMsg.Method)
	}
	if len(cancelMsg.ID) != 0 {
		t.Fatalf("session/cancel must be a notification (no id), got id %s", cancelMsg.ID)
	}

	// Agent honours the cancel by ending the turn — session stays alive.
	fa.writeResult(t, prompt.ID, promptResult{StopReason: "cancelled"})

	select {
	case sr := <-resCh:
		if sr.err != nil {
			t.Fatalf("submit error: %v", sr.err)
		}
		if sr.res.StopReason != "cancelled" {
			t.Fatalf("stopReason = %q, want cancelled", sr.res.StopReason)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("submit did not return after cancel")
	}
	if conv.sess.Load() == nil {
		t.Fatal("cancel must preserve the session, but it was dropped")
	}
}

func TestConversationAgentCrash(t *testing.T) {
	conv, fa := newConvHarness(t)
	col := newChunkCollector()

	resCh := make(chan submitResult, 1)
	go func() {
		r, err := conv.Submit(context.Background(), userReq("crash me"), col.cb)
		resCh <- submitResult{r, err}
	}()

	_ = fa.readMsg(t) // consume the prompt
	fa.closeStdout()  // agent dies mid-turn

	select {
	case sr := <-resCh:
		if !errors.Is(sr.err, errTransportClosed) {
			t.Fatalf("err = %v, want errTransportClosed", sr.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("submit did not return after crash")
	}
	if conv.sess.Load() != nil {
		t.Fatal("crash must drop the session so the next Submit re-spawns")
	}
}
