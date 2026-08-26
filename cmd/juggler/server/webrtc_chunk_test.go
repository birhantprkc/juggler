//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// marshalChunks models the wire trip a chunked DataChannel frame makes: each
// span becomes the Data field of a __juggler_dc_chunk envelope, which is where
// json.Marshal's UTF-8 coercion would damage a rune split across a boundary.
func marshalChunks(t *testing.T, payload []byte) [][]byte {
	t.Helper()
	bounds := webRTCChunkBounds(payload)
	frames := make([][]byte, 0, len(bounds))
	for i, b := range bounds {
		frame, err := json.Marshal(webRTCChunk{
			Type:  webRTCChunkType,
			ID:    "chunk-test",
			Index: i,
			Total: len(bounds),
			Data:  string(payload[b[0]:b[1]]),
		})
		if err != nil {
			t.Fatalf("marshal chunk %d: %v", i, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// TestWebRTCChunkingPreservesMultibyteRunes covers the corruption a naive
// fixed-width split causes: chunk data travels as a JSON string, so a rune
// straddling a boundary is coerced to U+FFFD in both halves and the reassembled
// frame still parses as JSON, leaving mangled text as the only symptom.
//
// The payload places a multi-byte rune across every offset spanning the first
// boundary, so a split that ignores rune boundaries cannot avoid cutting one.
func TestWebRTCChunkingPreservesMultibyteRunes(t *testing.T) {
	for offset := -3; offset <= 3; offset++ {
		// Pad with ASCII so the ellipsis (U+2026, bytes E2 80 A6) starts at
		// exactly webRTCChunkSize+offset, then fill past the boundary.
		lead := webRTCChunkSize + offset
		if lead < 0 {
			continue
		}
		payload := []byte(strings.Repeat("a", lead) + "…" + strings.Repeat("b", webRTCChunkSize))
		if !utf8.Valid(payload) {
			t.Fatalf("offset %d: test payload is not valid UTF-8", offset)
		}

		chunks := marshalChunks(t, payload)
		if len(chunks) < 2 {
			t.Fatalf("offset %d: expected a split payload, got %d chunk(s)", offset, len(chunks))
		}

		assembly := map[string]*webRTCChunkAssembly{}
		var assembled []byte
		for _, frame := range chunks {
			if !isWebRTCChunk(frame) {
				t.Fatalf("offset %d: frame not recognised as a chunk", offset)
			}
			out, complete := assembleWebRTCChunk(assembly, frame)
			if complete {
				assembled = out
			}
		}
		if assembled == nil {
			t.Fatalf("offset %d: chunks never reassembled", offset)
		}
		if string(assembled) != string(payload) {
			t.Errorf("offset %d: reassembled payload differs from the original (%d bytes in, %d out); "+
				"a rune was split across a chunk boundary and coerced to U+FFFD",
				offset, len(payload), len(assembled))
		}
	}
}

// TestWebRTCChunkBoundsStayWithinChunkSize pins the two invariants the receiver
// depends on: spans tile the payload in order with no gap or overlap, and none
// exceeds webRTCChunkSize (backing off to a rune boundary only ever shrinks a
// span, so the SCTP-friendly ceiling still holds).
func TestWebRTCChunkBoundsStayWithinChunkSize(t *testing.T) {
	payload := []byte(strings.Repeat("héllo wörld — ", 4000))
	bounds := webRTCChunkBounds(payload)
	if len(bounds) < 2 {
		t.Fatalf("expected a split payload, got %d span(s)", len(bounds))
	}
	prevEnd := 0
	for i, b := range bounds {
		if b[0] != prevEnd {
			t.Fatalf("span %d starts at %d, expected %d", i, b[0], prevEnd)
		}
		if b[1]-b[0] > webRTCChunkSize {
			t.Errorf("span %d is %d bytes, over the %d limit", i, b[1]-b[0], webRTCChunkSize)
		}
		if b[1] <= b[0] {
			t.Fatalf("span %d is empty", i)
		}
		if !utf8.Valid(payload[b[0]:b[1]]) {
			t.Errorf("span %d is not valid UTF-8", i)
		}
		prevEnd = b[1]
	}
	if prevEnd != len(payload) {
		t.Errorf("spans cover %d bytes of a %d-byte payload", prevEnd, len(payload))
	}
}

// TestWebRTCChunkBoundsAdvanceOnInvalidUTF8 guards the degenerate input: a run
// of continuation bytes offers no boundary to back off to, and the split must
// still advance rather than loop.
func TestWebRTCChunkBoundsAdvanceOnInvalidUTF8(t *testing.T) {
	payload := make([]byte, webRTCChunkSize*2+5)
	for i := range payload {
		payload[i] = 0x80 // continuation byte, never a rune start
	}
	bounds := webRTCChunkBounds(payload)
	total := 0
	for _, b := range bounds {
		if b[1] <= b[0] {
			t.Fatal("produced an empty span")
		}
		total += b[1] - b[0]
	}
	if total != len(payload) {
		t.Errorf("spans cover %d bytes of a %d-byte payload", total, len(payload))
	}
}
