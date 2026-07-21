//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"bufio"
	"bytes"
	"io"
	"net/http"
	"strings"

	"github.com/openai/openai-go/v3/option"
)

// The openai-go SSE decoder dispatches an event on every blank line and then
// feeds the accumulated `data:` payload straight to json.Unmarshal — with no
// guard for an empty payload. So a frame whose data is empty or whitespace-only
// makes json.Unmarshal fail with the stdlib "unexpected end of JSON input", and
// the SDK surfaces that as a hard stream error (see packages/ssestream).
//
// Two real-world upstream shapes trigger this, neither of which is a genuine
// protocol error:
//   - an empty data frame:            "data:\n\n"
//   - a comment keep-alive that is
//     immediately followed by a blank
//     line, leaving an empty payload: ": ping\n\n"
//
// The official OpenAI/DeepSeek endpoints rarely emit these, but relaying
// gateways (CLIProxyAPI, OpenRouter, and similar) interpose heartbeat/keep-alive
// frames in exactly this form, so users behind those proxies hit
// "LLM error: unexpected end of JSON input" mid-stream. Upstream has no fix
// through the latest release (the decode loop is unchanged and unguarded), so we
// filter the stream one layer below the decoder.
//
// sseEmptyFrameFilterMiddleware wraps the streaming HTTP response body so these
// no-payload frames are dropped before the SDK's decoder ever sees them. It is a
// strict no-op for any non-event-stream response (model listing, error bodies,
// etc.), so it is safe to install unconditionally on every OpenAI-compatible
// client.
func sseEmptyFrameFilterMiddleware(req *http.Request, next option.MiddlewareNext) (*http.Response, error) {
	resp, err := next(req)
	if err != nil || resp == nil || resp.Body == nil {
		return resp, err
	}
	ct := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Type")))
	if !strings.HasPrefix(ct, "text/event-stream") {
		return resp, err
	}
	resp.Body = newSSEEmptyFrameFilter(resp.Body)
	return resp, nil
}

// sseEmptyFrameFilter is an io.ReadCloser that passes an SSE byte stream through
// verbatim except that it drops whole frames whose dispatched `data:` payload
// would be empty or whitespace-only. It tokenizes lines exactly as the SDK's own
// decoder does (bufio.Scanner with the same oversized buffer), so whatever the
// SDK can parse, this sees identically — it only removes frames that would
// otherwise crash the decoder.
type sseEmptyFrameFilter struct {
	body     io.ReadCloser
	scn      *bufio.Scanner
	out      bytes.Buffer // decoded, ready-to-read output bytes
	frame    bytes.Buffer // current frame's lines, buffered until its blank-line dispatch
	hasData  bool         // current frame carries at least one non-whitespace data byte
	scanDone bool
	scanErr  error
}

func newSSEEmptyFrameFilter(body io.ReadCloser) *sseEmptyFrameFilter {
	scn := bufio.NewScanner(body)
	// Match the SDK's decoder buffer so a large single data line (a big delta)
	// is not rejected as "token too long" here when the SDK would accept it.
	scn.Buffer(nil, bufio.MaxScanTokenSize<<9)
	return &sseEmptyFrameFilter{body: body, scn: scn}
}

// fill pulls lines from the underlying stream until at least one complete,
// non-empty frame has been emitted into out, or the stream ends. Suppressed
// (empty-payload) frames are consumed and produce no output.
func (f *sseEmptyFrameFilter) fill() {
	for f.out.Len() == 0 && !f.scanDone {
		if !f.scn.Scan() {
			f.scanDone = true
			f.scanErr = f.scn.Err()
			// A trailing frame with no blank-line terminator is never dispatched
			// by the SDK decoder, so drop whatever is buffered rather than emit a
			// dangling (possibly empty) frame.
			f.frame.Reset()
			f.hasData = false
			return
		}

		line := f.scn.Bytes()
		if len(line) == 0 {
			// Blank line: the SDK dispatches the frame here. Keep it only if it
			// carried real data; otherwise suppress the whole frame.
			if f.hasData {
				f.out.Write(f.frame.Bytes())
				f.out.WriteByte('\n')
			}
			f.frame.Reset()
			f.hasData = false
			continue
		}

		// Buffer the raw line (Scanner strips the terminator; re-add "\n", which
		// the SDK's line scanner tokenizes the same way as "\r\n").
		f.frame.Write(line)
		f.frame.WriteByte('\n')

		// Mirror the SDK's field parse to decide whether this is a data line with
		// a non-whitespace value.
		name, value, _ := bytes.Cut(line, []byte(":"))
		if string(name) == "data" {
			if len(value) > 0 && value[0] == ' ' {
				value = value[1:]
			}
			if len(bytes.TrimSpace(value)) > 0 {
				f.hasData = true
			}
		}
	}
}

func (f *sseEmptyFrameFilter) Read(p []byte) (int, error) {
	if f.out.Len() == 0 {
		f.fill()
	}
	if f.out.Len() > 0 {
		return f.out.Read(p)
	}
	if f.scanErr != nil {
		return 0, f.scanErr
	}
	return 0, io.EOF
}

func (f *sseEmptyFrameFilter) Close() error {
	return f.body.Close()
}
