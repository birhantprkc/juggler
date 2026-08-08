//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "juggler/cmd/juggler/core"

// metaProvisionalName is the doc-metadata marker recording the PROVENANCE of a
// conversation's name: true while the name is provisional — machine-derived and
// free to be replaced — false once a human has typed one and the name is theirs.
// "Untitled 3", "Fix login redirect (continued)", and a title the auto-namer
// wrote are all provisional; only a hand-typed name is committed. (Distinct from
// core.IsUntitledName, which tests one specific provisional shape: the bare
// numbered placeholder.)
//
// The name itself is not in the doc — it is the on-disk folder name — so this
// marker is the only record of where that name came from, and it is what gates
// auto-naming: a provisional tab stays eligible, which is how /handoff re-derives
// a title for its "(continued)" tab, a name no placeholder test would ever match.
//
// Written by the browser at the naming seams — a rename clears it, the
// "Auto-name" button and /handoff set it — and seeded here on first init.
// Riding in doc metadata means a clone inherits it through the server-side
// doc.yjs copy, and renaming, binning, or restoring a conversation (all folder
// moves) carries it untouched. Metadata sits outside the UndoManager's `items`
// scope, so none of these writes are undoable.
const metaProvisionalName = "isProvisionalName"

// NameIsProvisional reports whether this conversation's name may still be
// replaced by the auto-namer. An absent marker — a doc written before the marker
// existed — falls back to the name shape that used to gate auto-naming on its
// own: a bare "Untitled N" placeholder is provisional, anything else is presumed
// chosen by the user. Upgrading therefore changes no existing conversation's
// behaviour, and seedNameIsProvisional persists the answer on the next init,
// after which the marker alone decides.
//
// A name that does not resolve at all (no path provider, unparseable folder)
// counts as provisional: no user-chosen name is known, and the alternative
// reading would silently switch auto-naming off rather than fail visibly.
func (w *ConversationWorker) NameIsProvisional() bool {
	if provisional, ok := w.doc.GetMetadata(metaProvisionalName).(bool); ok {
		return provisional
	}
	name := w.conversationName()
	return name == "" || core.IsUntitledName(name)
}

// seedNameIsProvisional persists the resolved marker once, on a worker's first
// init: a fresh conversation resolves from its "Untitled N" placeholder
// (provisional), one created with an explicit name from that name (committed),
// and a doc predating the marker is migrated from whatever it is called now.
//
// Only ever writes when the marker is absent. A conversation whose marker has
// been set by a rename, the "Auto-name" button, or /handoff owns its own value,
// which must survive the next load rather than being re-derived from a name that
// no longer says anything about its provenance. An unresolvable folder is left
// unseeded rather than guessed at: NameIsProvisional answers from the name until
// an init can read one.
func (w *ConversationWorker) seedNameIsProvisional() {
	if w.doc.GetMetadata(metaProvisionalName) != nil {
		return
	}
	name := w.conversationName()
	if name == "" {
		return
	}
	w.doc.SetMetadata(metaProvisionalName, core.IsUntitledName(name))
}
