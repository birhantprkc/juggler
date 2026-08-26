//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// namedWorker builds an auto-name worker whose on-disk folder gives it the
// supplied conversation name, so conversationName() (and therefore the seed and
// the absent-marker fallback) resolve exactly as they do in production.
func namedWorker(t *testing.T, id, name string, calls *[]autoNameCall) *ConversationWorker {
	t.Helper()
	w := newAutoNameWorker(t, id, calls)
	dir := filepath.Join(t.TempDir(), name+"--"+id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	w.SetPathProvider(func(convID string) (string, bool) { return dir, convID == id })
	return w
}

// TestNameIsProvisionalFallsBackToNameShape pins the migration path for a doc written
// before the marker existed: with no marker, the name decides, exactly as the
// old placeholder-only guard did.
func TestNameIsProvisionalFallsBackToNameShape(t *testing.T) {
	var calls []autoNameCall

	placeholder := namedWorker(t, "conv_untitled", "Untitled 3", &calls)
	if !placeholder.NameIsProvisional() {
		t.Error("NameIsProvisional() = false for an unmarked \"Untitled 3\", want true")
	}

	named := namedWorker(t, "conv_named", "Fix login redirect", &calls)
	if named.NameIsProvisional() {
		t.Error("NameIsProvisional() = true for an unmarked user-named conversation, want false")
	}
}

// TestNameIsProvisionalMarkerWins pins that the marker, once written, overrides the name
// shape in both directions — the whole point of the flag. A "(continued)" tab
// marked provisional is eligible; an auto-named tab the user renamed is not, even though
// neither name is a placeholder.
func TestNameIsProvisionalMarkerWins(t *testing.T) {
	var calls []autoNameCall

	continued := namedWorker(t, "conv_continued", "Fix login redirect (continued)", &calls)
	continued.doc.SetMetadata(metaProvisionalName, true)
	if !continued.NameIsProvisional() {
		t.Error("NameIsProvisional() = false for a conversation marked provisional, want true")
	}

	// A placeholder name marked NOT provisional (the user renamed a tab back to
	// something that happens to look like one) must be left alone.
	renamed := namedWorker(t, "conv_renamed", "Untitled 4", &calls)
	renamed.doc.SetMetadata(metaProvisionalName, false)
	if renamed.NameIsProvisional() {
		t.Error("NameIsProvisional() = true for a conversation marked committed, want false")
	}
}

// TestSeedNameIsProvisionalWritesOnceFromName covers the init seed: it resolves from the
// current name when absent, and never overwrites a marker already in the doc (a
// rename's cleared flag must survive the next load).
func TestSeedNameIsProvisionalWritesOnceFromName(t *testing.T) {
	var calls []autoNameCall

	fresh := namedWorker(t, "conv_seedfresh", "Untitled 1", &calls)
	fresh.seedNameIsProvisional()
	if provisional, ok := fresh.doc.GetMetadata(metaProvisionalName).(bool); !ok || !provisional {
		t.Fatalf("seeded marker = %v (ok=%v), want true for a placeholder name", provisional, ok)
	}

	kept := namedWorker(t, "conv_seedkept", "Untitled 2", &calls)
	kept.doc.SetMetadata(metaProvisionalName, false)
	kept.seedNameIsProvisional()
	if provisional, _ := kept.doc.GetMetadata(metaProvisionalName).(bool); provisional {
		t.Error("seedNameIsProvisional overwrote an existing marker; a cleared flag must survive reload")
	}
}

// TestSeedNameIsProvisionalSkipsUnresolvableName verifies an unreadable folder is left
// unseeded rather than guessed at — persisting false there would silently switch
// auto-naming off for the conversation forever.
func TestSeedNameIsProvisionalSkipsUnresolvableName(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv_nopath", &calls) // no path provider

	w.seedNameIsProvisional()

	if v := w.doc.GetMetadata(metaProvisionalName); v != nil {
		t.Fatalf("marker = %v, want unset when the conversation name can't be resolved", v)
	}
}

// TestAutoNameSkippedWhenNameIsUserChosen pins the fire guard on the automatic
// path: a conversation the user has named gets no naming call on its first
// message.
func TestAutoNameSkippedWhenNameIsUserChosen(t *testing.T) {
	var calls []autoNameCall
	w := namedWorker(t, "conv_usernamed", "Fix login redirect", &calls)
	w.doc.SetMetadata(metaProvisionalName, false)

	sendMsg(t, w, SendMessageMessage{Text: "Add a dark mode toggle"})

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call for a user-named conversation, got %+v", calls)
	}
}

// TestRequestAutoNameUnforcedRespectsMarker pins /handoff's path: an unforced
// request applies only while the name is provisional, and carries force=false
// so the server applies the user's auto-naming setting too.
func TestRequestAutoNameUnforcedRespectsMarker(t *testing.T) {
	var calls []autoNameCall
	w := namedWorker(t, "conv_unforced", "Fix login redirect (continued)", &calls)
	w.currentRun().addUserMessage(UserMessageInput{Text: "Handoff summary: the auth refactor so far"})

	w.doc.SetMetadata(metaProvisionalName, false)
	requestAutoName(t, w, false)
	if len(calls) != 0 {
		t.Fatalf("unforced request fired for a user-named conversation: %+v", calls)
	}

	w.doc.SetMetadata(metaProvisionalName, true)
	requestAutoName(t, w, false)
	if len(calls) != 1 {
		t.Fatalf("expected 1 auto-name call once marked provisional, got %d", len(calls))
	}
	if calls[0].force {
		t.Error("unforced request signalled force=true; the server's enable gate would be bypassed")
	}
}

// TestRequestAutoNameForcedIgnoresMarker pins the tab bar's button: the user
// asked for a name, so neither the marker nor the enable setting stands in the
// way.
func TestRequestAutoNameForcedIgnoresMarker(t *testing.T) {
	var calls []autoNameCall
	w := namedWorker(t, "conv_forced", "Fix login redirect", &calls)
	w.doc.SetMetadata(metaProvisionalName, false)
	w.currentRun().addUserMessage(UserMessageInput{Text: "Refactor the auth layer"})

	requestAutoName(t, w, true)

	if len(calls) != 1 || !calls[0].force {
		t.Fatalf("expected 1 forced auto-name call regardless of the marker, got %+v", calls)
	}
}

// TestNameIsProvisionalKeyMatchesJS pins the cross-language contract for the marker key.
// Go writes and reads it here; the browser writes it at the naming seams via
// web/js/model/conversation-naming.js. A silent typo in either would not fail to
// compile — auto-naming would simply stop working — so the key is compared at
// build time (mirrors TestUntitledNamingMatchesJS in core).
func TestNameIsProvisionalKeyMatchesJS(t *testing.T) {
	const jsPath = "../../../web/js/model/conversation-naming.js"
	raw, err := os.ReadFile(jsPath)
	if err != nil {
		t.Fatalf("read %s: %v", jsPath, err)
	}
	src := strings.ReplaceAll(string(raw), "\r\n", "\n")

	const decl = "export const PROVISIONAL_NAME_KEY ="
	i := strings.Index(src, decl)
	if i < 0 {
		t.Fatalf("%s: %q not found", jsPath, decl)
	}
	rest := strings.TrimLeft(src[i+len(decl):], " ")
	if len(rest) == 0 || (rest[0] != '\'' && rest[0] != '"') {
		t.Fatalf("%s: no opening quote after %q", jsPath, decl)
	}
	end := strings.IndexByte(rest[1:], rest[0])
	if end < 0 {
		t.Fatalf("%s: no closing quote after %q", jsPath, decl)
	}
	if jsKey := rest[1 : 1+end]; jsKey != metaProvisionalName {
		t.Fatalf("JS PROVISIONAL_NAME_KEY = %q, Go metaProvisionalName = %q — update both together", jsKey, metaProvisionalName)
	}
}
