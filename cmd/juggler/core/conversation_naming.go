//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"regexp"
)

// Conversation placeholder naming — the SINGLE SOURCE OF TRUTH for the default
// names an untitled conversation carries before it is titled (by the user or the
// auto-namer). The browser keeps a byte-identical twin in
// web/js/model/conversation-naming.js; conversation_naming_test.go reads that file
// and asserts the two never drift. Change them together.
//
// Two shapes share one base word:
//   - UntitledBase ("Untitled") — the bare display/folder fallback for a
//     conversation that has no name yet.
//   - UntitledName(n) ("Untitled 1", "Untitled 2", …) — the numbered placeholder a
//     freshly-created blank conversation requests.
//
// The auto-namer renames a conversation ONLY while its name still matches the
// numbered shape (IsUntitledName): that is how a user-titled or duplicated
// conversation is spared. Because the generator (UntitledName) and the matcher
// (IsUntitledName) gate that decision together, they must never drift — hence one
// definition here rather than a hand-typed `^Untitled \d+$` at each call site.
const UntitledBase = "Untitled"

// untitledNameRe matches exactly the numbered placeholder shape ("Untitled 7"),
// anchored end to end. Built from UntitledBase so the base word is stated once.
var untitledNameRe = regexp.MustCompile(`^` + regexp.QuoteMeta(UntitledBase) + ` \d+$`)

// UntitledName returns the numbered placeholder for n (n >= 1).
func UntitledName(n int) string { return fmt.Sprintf("%s %d", UntitledBase, n) }

// IsUntitledName reports whether name is a bare numbered placeholder ("Untitled 7"):
// a conversation still carrying its auto-assigned default name, and therefore a
// candidate for auto-naming.
func IsUntitledName(name string) bool { return untitledNameRe.MatchString(name) }
