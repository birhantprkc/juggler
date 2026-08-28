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

	"juggler/cmd/juggler/providers/provider"
)

// newConvHarness builds a conversation with a live session pre-installed over
// pipes, bypassing spawn+handshake so a turn can be driven deterministically.
func newConvHarness(t *testing.T) (*conversation, *fakeAgentPipes) {
	t.Helper()
	fa := newFakeAgent()
	conv := newConversation(&Client{workingDir: "/tmp"}, "c1", defaultApprover{})
	thread := conv.thread("")
	tr := newTransport(fa.clientStdin, fa.clientStdout, nil, nil)
	tr.start(thread)
	thread.sess.Store(&session{rpc: tr, sessionID: "s1"})
	t.Cleanup(func() {
		_ = conv.Close()
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

func threadReq(threadID, text string) provider.MessageRequest {
	req := userReq(text)
	req.ThreadID = threadID
	return req
}

func installThreadHarness(t *testing.T, conv *conversation, threadID, sessionID string) *fakeAgentPipes {
	t.Helper()
	fa := newFakeAgent()
	thread := conv.thread(threadID)
	tr := newTransport(fa.clientStdin, fa.clientStdout, nil, nil)
	tr.start(thread)
	thread.sess.Store(&session{rpc: tr, sessionID: sessionID})
	t.Cleanup(fa.stop)
	return fa
}

func TestConversationConcurrentThreadRouting(t *testing.T) {
	conv := newConversation(&Client{workingDir: "/tmp"}, "c1", defaultApprover{})
	t.Cleanup(func() { _ = conv.Close() })
	rootAgent := installThreadHarness(t, conv, "", "root-session")
	childAgent := installThreadHarness(t, conv, "child", "child-session")
	rootChunks := newChunkCollector()
	childChunks := newChunkCollector()

	rootResult := make(chan submitResult, 1)
	childResult := make(chan submitResult, 1)
	go func() {
		res, err := conv.Submit(context.Background(), threadReq("", "root prompt"), rootChunks.cb)
		rootResult <- submitResult{res, err}
	}()
	go func() {
		res, err := conv.Submit(context.Background(), threadReq("child", "child prompt"), childChunks.cb)
		childResult <- submitResult{res, err}
	}()

	rootPrompt := rootAgent.readMsg(t)
	childPrompt := childAgent.readMsg(t)
	rootAgent.writeNotification(t, "session/update", sessionUpdateParams{SessionID: "root-session", Update: sessionUpdate{SessionUpdate: updAgentMessageChunk, Content: &updateContent{Type: "text", Text: "root-only"}}})
	childAgent.writeNotification(t, "session/update", sessionUpdateParams{SessionID: "child-session", Update: sessionUpdate{SessionUpdate: updAgentMessageChunk, Content: &updateContent{Type: "text", Text: "child-one"}}})
	rootAgent.writeResult(t, rootPrompt.ID, promptResult{StopReason: "end_turn"})
	if result := <-rootResult; result.err != nil {
		t.Fatalf("root submit: %v", result.err)
	}

	// The root turn returning must not clear the still-active child's callback.
	childAgent.writeNotification(t, "session/update", sessionUpdateParams{SessionID: "child-session", Update: sessionUpdate{SessionUpdate: updAgentMessageChunk, Content: &updateContent{Type: "text", Text: "-child-two"}}})
	childAgent.writeResult(t, childPrompt.ID, promptResult{StopReason: "end_turn"})
	if result := <-childResult; result.err != nil {
		t.Fatalf("child submit: %v", result.err)
	}

	rootText, _ := rootChunks.textAndThinking()
	childText, _ := childChunks.textAndThinking()
	if rootText != "root-only" {
		t.Fatalf("root callback text = %q, want root-only", rootText)
	}
	if childText != "child-one-child-two" {
		t.Fatalf("child callback text = %q, want child-one-child-two", childText)
	}
}

func TestConversationCancelIsThreadIsolated(t *testing.T) {
	conv := newConversation(&Client{workingDir: "/tmp"}, "c1", defaultApprover{})
	t.Cleanup(func() { _ = conv.Close() })
	rootAgent := installThreadHarness(t, conv, "", "root-session")
	childAgent := installThreadHarness(t, conv, "child", "child-session")

	rootResult := make(chan submitResult, 1)
	childResult := make(chan submitResult, 1)
	go func() {
		res, err := conv.Submit(context.Background(), threadReq("", "root prompt"), newChunkCollector().cb)
		rootResult <- submitResult{res, err}
	}()
	go func() {
		res, err := conv.Submit(context.Background(), threadReq("child", "child prompt"), newChunkCollector().cb)
		childResult <- submitResult{res, err}
	}()
	rootPrompt := rootAgent.readMsg(t)
	childPrompt := childAgent.readMsg(t)

	conv.Cancel("child")
	cancel := childAgent.readMsg(t)
	if cancel.Method != "session/cancel" {
		t.Fatalf("child method = %q, want session/cancel", cancel.Method)
	}
	var params cancelParams
	if err := json.Unmarshal(cancel.Params, &params); err != nil {
		t.Fatalf("decode cancel: %v", err)
	}
	if params.SessionID != "child-session" {
		t.Fatalf("cancel session = %q, want child-session", params.SessionID)
	}
	select {
	case msg := <-rootAgent.inbox:
		t.Fatalf("root received crossover message: method=%q", msg.Method)
	case <-time.After(100 * time.Millisecond):
	}

	childAgent.writeResult(t, childPrompt.ID, promptResult{StopReason: "cancelled"})
	rootAgent.writeResult(t, rootPrompt.ID, promptResult{StopReason: "end_turn"})
	if result := <-childResult; result.err != nil || result.res.StopReason != "cancelled" {
		t.Fatalf("child result = %+v, err %v", result.res, result.err)
	}
	if result := <-rootResult; result.err != nil || result.res.StopReason != "end_turn" {
		t.Fatalf("root result = %+v, err %v", result.res, result.err)
	}
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
		if !sr.res.InputTokensApproximate {
			t.Fatal("InputTokensApproximate = false, want true for ACP local estimate")
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

	conv.Cancel("")

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
	if conv.thread("").sess.Load() == nil {
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
	if conv.thread("").sess.Load() != nil {
		t.Fatal("crash must drop the session so the next Submit re-spawns")
	}
}
