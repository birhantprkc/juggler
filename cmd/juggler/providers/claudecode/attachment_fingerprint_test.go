//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// imageUserMsg builds a user message carrying image parts referenced by the
// given asset ids. Bytes are deliberately omitted — the fingerprint must key
// on AssetID, never on the rendered base64.
func imageUserMsg(content string, assetIDs ...string) provider.Message {
	parts := make([]provider.MediaPart, 0, len(assetIDs))
	for _, id := range assetIDs {
		parts = append(parts, provider.MediaPart{Type: "image", Mime: "image/png", AssetID: id})
	}
	return provider.Message{Type: "user", Content: content, Parts: parts}
}

// TestFingerprint_KeysOnAssetIDNotBytes is B4: the claudecode request-prefix
// fingerprint (writeMessageFields, via hashMessage) must change iff the set of
// attachment AssetIDs changes — so re-sending the same image keeps the warm
// session, while adding/removing/swapping an image forces a fresh start. The
// raw bytes are never hashed, so two parts with the same AssetID but different
// Data hash identically.
func TestFingerprint_KeysOnAssetIDNotBytes(t *testing.T) {
	withImage := imageUserMsg("look", "sha-A")

	// Same AssetID, different bytes → same fingerprint (bytes are not hashed).
	sameIDDifferentBytes := imageUserMsg("look", "sha-A")
	sameIDDifferentBytes.Parts[0].Data = []byte("totally different bytes")
	if hashMessage(&withImage) != hashMessage(&sameIDDifferentBytes) {
		t.Error("fingerprint changed when only the bytes (not AssetID) differ — would needlessly cold-start every image turn")
	}

	// No attachment → must differ from the with-image message.
	noImage := provider.Message{Type: "user", Content: "look"}
	if hashMessage(&noImage) == hashMessage(&withImage) {
		t.Error("attaching an image must change the fingerprint")
	}

	// Different AssetID → must differ (edited/replaced image forces fresh start).
	differentID := imageUserMsg("look", "sha-B")
	if hashMessage(&withImage) == hashMessage(&differentID) {
		t.Error("changing the AssetID must change the fingerprint")
	}

	// Adding a second attachment → must differ.
	twoImages := imageUserMsg("look", "sha-A", "sha-C")
	if hashMessage(&withImage) == hashMessage(&twoImages) {
		t.Error("adding a second attachment must change the fingerprint")
	}
}

// TestFingerprint_PrefixWarmAcrossResend confirms the property at the
// request-prefix level the resume check actually uses: an unchanged image
// turn keeps the prefix hash stable (warm resume), while removing the image
// flips it (fresh start).
func TestFingerprint_PrefixWarmAcrossResend(t *testing.T) {
	sys := "you are helpful"
	base := []provider.Message{
		imageUserMsg("here is a screenshot", "sha-IMG"),
		assistantMsg("I see it"),
	}
	warm := hashRequestPrefix(sys, base, 2)

	// Re-sending byte-identical prefix → identical hash (warm resume).
	resend := []provider.Message{
		imageUserMsg("here is a screenshot", "sha-IMG"),
		assistantMsg("I see it"),
	}
	if got := hashRequestPrefix(sys, resend, 2); got != warm {
		t.Errorf("re-sending the same image must keep the prefix warm: got %d want %d", got, warm)
	}

	// Removing the attachment → different hash (forces fresh start).
	noImage := []provider.Message{
		userMsg("here is a screenshot"),
		assistantMsg("I see it"),
	}
	if got := hashRequestPrefix(sys, noImage, 2); got == warm {
		t.Errorf("removing the image must change the prefix hash (force fresh start); both = %d", got)
	}
}
