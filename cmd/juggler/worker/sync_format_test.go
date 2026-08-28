//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

// formatWorkerMessageEncodingJSON is the previous encoding/json implementation,
// kept verbatim as the reference oracle: the optimised FormatWorkerMessage must
// produce byte-identical output for every payload the server can actually
// generate, or the wire format has silently changed.
func formatWorkerMessageEncodingJSON(conversationID string, workerMsg []byte) []byte {
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

// realisticPayloads returns payloads shaped like the ones the worker actually
// sends. Each is produced by json.Marshal, which is the invariant the optimised
// path relies on: ConversationWorker.send and .reply are the only producers and
// both marshal (and bail on error), so a payload is always valid, compact,
// already-HTML-escaped encoder output.
//
// Building them with json.Marshal rather than hand-written literals is
// deliberate — it is exactly the class of input that reaches the function, and
// it pins the equivalence claim to reality rather than to a guess about it.
func realisticPayloads(t testingTB) map[string][]byte {
	t.Helper()
	blob := bytes.Repeat([]byte{0xDE, 0xAD, 0xBE, 0xEF}, 4096) // base64s in the JSON
	cases := map[string]any{
		"yjs-sync": YjsSyncMessage{Type: "yjs-sync", Bytes: blob},
		"yjs-sync-engine-derived": YjsSyncMessage{
			Type: "yjs-sync", Bytes: blob, EngineDerived: true,
		},
		// Characters encoding/json escapes: <, >, & become \u003c/\u003e/\u0026,
		// so the old path's HTML-escaping compaction pass had nothing left to do
		// — which is why copying the payload verbatim is equivalent.
		"html-ish-content": map[string]any{
			"type": "status",
			"text": `<script>a && b > c</script>`,
		},
		"unicode-and-escapes": map[string]any{
			"type": "status",
			"text": "emoji 🤹 quote \" backslash \\ newline \n tab \t",
		},
		"nested-structure": map[string]any{
			"type": "ready",
			"metadata": map[string]any{
				"items":  []any{1, 2.5, true, nil, "x"},
				"nested": map[string]any{"deep": map[string]any{"deeper": "value"}},
			},
		},
		"empty-object-payload": map[string]any{"type": "ping"},
	}
	out := make(map[string][]byte, len(cases))
	for name, v := range cases {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("fixture %q failed to marshal: %v", name, err)
		}
		out[name] = b
	}
	return out
}

// testingTB is the subset of testing.TB the fixtures need, so the same builder
// serves both the tests and the benchmarks.
type testingTB interface {
	Helper()
	Fatalf(format string, args ...any)
}

func TestFormatWorkerMessageMatchesEncodingJSON(t *testing.T) {
	convIDs := []string{
		"conv_vhwcsgd83",
		"", // defensive: an unset conversation id must still round-trip
		`conv_with_"quote"_and_\backslash`,
		"conv_🤹_unicode",
	}
	for name, payload := range realisticPayloads(t) {
		for i, convID := range convIDs {
			t.Run(fmt.Sprintf("%s/convID%d", name, i), func(t *testing.T) {
				want := formatWorkerMessageEncodingJSON(convID, payload)
				got := FormatWorkerMessage(convID, payload)
				if !bytes.Equal(got, want) {
					t.Errorf("envelope differs from encoding/json\n got: %s\nwant: %s",
						truncate(got), truncate(want))
				}
				// And it must still be valid JSON that decodes to the same envelope.
				var back WorkerMessage
				if err := json.Unmarshal(got, &back); err != nil {
					t.Fatalf("envelope is not valid JSON: %v", err)
				}
				if back.Type != "worker-message" || back.ConversationID != convID {
					t.Errorf("decoded envelope wrong: type=%q convID=%q", back.Type, back.ConversationID)
				}
				if !bytes.Equal(back.Payload, payload) {
					t.Error("payload did not survive the round trip byte-for-byte")
				}
			})
		}
	}
}

func TestFormatWorkerMessageRejectsUnusable(t *testing.T) {
	cases := map[string][]byte{
		"nil":              nil,
		"empty":            {},
		"not json":         []byte("not json at all"),
		"truncated":        []byte(`{"type":"yjs-sync"`),
		"missing type":     []byte(`{"bytes":"AAAA"}`),
		"non-string type":  []byte(`{"type":123}`),
		"array not object": []byte(`["type","yjs-sync"]`),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if got := FormatWorkerMessage("conv_x", payload); got != nil {
				t.Errorf("expected nil for unusable payload, got %s", truncate(got))
			}
		})
	}
}

func truncate(b []byte) string {
	const max = 200
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + fmt.Sprintf("… (%d bytes)", len(b))
}

// benchPayload builds a yjs-sync message of roughly the given size — the shape
// that dominates a viewer sync, and the reason this function showed up at 64%
// of server CPU in a profile.
func benchPayload(b *testing.B, approxBytes int) []byte {
	b.Helper()
	blob := bytes.Repeat([]byte{0x01, 0x02, 0x03}, approxBytes/4)
	payload, err := json.Marshal(YjsSyncMessage{Type: "yjs-sync", Bytes: blob})
	if err != nil {
		b.Fatalf("marshal fixture: %v", err)
	}
	return payload
}

func BenchmarkFormatWorkerMessage(b *testing.B) {
	for _, size := range []int{4 << 10, 256 << 10, 8 << 20} {
		payload := benchPayload(b, size)
		b.Run(fmt.Sprintf("new/%dKiB", len(payload)>>10), func(b *testing.B) {
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if FormatWorkerMessage("conv_vhwcsgd83", payload) == nil {
					b.Fatal("unexpected nil")
				}
			}
		})
		b.Run(fmt.Sprintf("old_encoding_json/%dKiB", len(payload)>>10), func(b *testing.B) {
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if formatWorkerMessageEncodingJSON("conv_vhwcsgd83", payload) == nil {
					b.Fatal("unexpected nil")
				}
			}
		})
	}
}

// The yjs-sync payload is the other half of the same problem FormatWorkerMessage
// solves. The envelope around it is now assembled in one exactly-sized buffer,
// but the payload inside it was still built by encoding/json, which cannot be
// told how large its output will be and so grows by doubling — a dozen
// reallocations and a full copy each time, on the largest thing the process
// holds. marshalYjsSync sizes it exactly and encodes base64 straight into the
// result; these pin that it changed nothing on the wire.

// TestMarshalYjsSyncMatchesEncodingJSON is the equivalence claim, checked
// against the real encoder rather than a hand-written expectation, so a change
// in either implementation has to be made on purpose.
func TestMarshalYjsSyncMatchesEncodingJSON(t *testing.T) {
	updates := map[string][]byte{
		"nil":                    nil,
		"empty":                  {},
		"one byte":               {0x00},
		"under a base64 group":   {0xDE, 0xAD},
		"exactly a base64 group": {0xDE, 0xAD, 0xBE},
		"over a base64 group":    {0xDE, 0xAD, 0xBE, 0xEF},
		// The bytes whose base64 uses the whole alphabet, including + and /,
		// which must reach the wire unescaped.
		"full alphabet": func() []byte {
			b := make([]byte, 256)
			for i := range b {
				b[i] = byte(i)
			}
			return b
		}(),
		"large": bytes.Repeat([]byte{0x01, 0x02, 0x03}, 100_000),
	}
	for name, update := range updates {
		for _, derived := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/engineDerived=%v", name, derived), func(t *testing.T) {
				want, err := json.Marshal(YjsSyncMessage{
					Type: "yjs-sync", Bytes: update, EngineDerived: derived,
				})
				if err != nil {
					t.Fatalf("reference marshal failed: %v", err)
				}
				got := marshalYjsSync(update, derived)
				if !bytes.Equal(got, want) {
					t.Errorf("payload differs from encoding/json\n got: %s\nwant: %s",
						truncate(got), truncate(want))
				}
				// And it must decode back to the message it claims to be, so a
				// matching byte string cannot be a matching pair of mistakes.
				var back YjsSyncMessage
				if err := json.Unmarshal(got, &back); err != nil {
					t.Fatalf("payload is not valid JSON: %v", err)
				}
				if back.Type != "yjs-sync" || back.EngineDerived != derived {
					t.Errorf("decoded wrong: type=%q engineDerived=%v", back.Type, back.EngineDerived)
				}
				if !bytes.Equal(back.Bytes, update) {
					t.Error("the update did not survive the round trip byte-for-byte")
				}
			})
		}
	}
}

// TestMarshalYjsSyncIsExactlySized is the point of the exercise, stated as a
// property of the result rather than as an allocation count: the output size is
// a pure function of the update's length, so the buffer must come back exactly
// full — never grown, never slack. That is what makes the whole payload one
// allocation, and it is what encoding/json cannot do.
//
// Deliberately not testing.AllocsPerRun. It counts allocations process-wide and
// is documented as unreliable while other goroutines run; this package starts
// plenty, so it passes alone and fails in the package run. len == cap is the
// same claim, checked deterministically.
func TestMarshalYjsSyncIsExactlySized(t *testing.T) {
	for _, n := range []int{0, 1, 2, 3, 4, 5, 6, 1023, 1024, 65_537} {
		for _, derived := range []bool{false, true} {
			got := marshalYjsSync(bytes.Repeat([]byte{0xAB}, n), derived)
			if len(got) != cap(got) {
				t.Errorf("update of %d bytes (engineDerived=%v): len %d, cap %d — the size was not computed exactly",
					n, derived, len(got), cap(got))
			}
		}
	}
}

func BenchmarkMarshalYjsSync(b *testing.B) {
	for _, size := range []int{4 << 10, 256 << 10, 8 << 20} {
		update := bytes.Repeat([]byte{0x01, 0x02, 0x03}, size/3)
		b.Run(fmt.Sprintf("new/%dKiB", len(update)>>10), func(b *testing.B) {
			b.SetBytes(int64(len(update)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if marshalYjsSync(update, false) == nil {
					b.Fatal("unexpected nil")
				}
			}
		})
		b.Run(fmt.Sprintf("old_encoding_json/%dKiB", len(update)>>10), func(b *testing.B) {
			b.SetBytes(int64(len(update)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if _, err := json.Marshal(YjsSyncMessage{Type: "yjs-sync", Bytes: update}); err != nil {
					b.Fatalf("marshal: %v", err)
				}
			}
		})
	}
}
