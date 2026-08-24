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

// metaAutoNamed records that the auto-namer has already been fired for this
// conversation. It is what makes auto-naming happen ONCE, and it exists because
// the only other available answer — "does the root items array contain a user
// message?" — is not a property of the conversation but of its current shape,
// and compaction changes that shape: a fold moves every root user message into
// the nested items of a summary thread, so a doc scan reports an empty
// conversation and the next thing typed gets treated as the first message and
// retitles the tab.
//
// A conversation's identity must not depend on how much of its history is
// currently folded, so this is recorded once and never re-derived. It rides in
// doc metadata beside metaProvisionalName: it syncs, it survives a reload, a
// clone inherits it, and it sits outside the UndoManager's `items` scope so
// undoing a fold cannot resurrect it. The tab bar's "Auto-name" button passes
// force and is not gated by it.
const metaAutoNamed = "hasAutoNamed"

// hasAutoNamed reports whether the auto-namer has already run for this
// conversation. An absent marker — a doc written before the marker existed —
// falls back to the doc scan that used to gate the trigger on its own, so
// upgrading re-names nothing that was already named; seedHasAutoNamed persists
// the answer on the next init, after which the marker alone decides. See
// metaAutoNamed.
func (w *ConversationWorker) hasAutoNamed() bool {
	if named, ok := w.doc.GetMetadata(metaAutoNamed).(bool); ok {
		return named
	}
	return w.firstRootUserMessageText() != ""
}

// seedHasAutoNamed persists the resolved marker once, on a worker's first init,
// so a conversation that predates the marker keeps its current name. Only ever
// writes when the marker is absent.
func (w *ConversationWorker) seedHasAutoNamed() {
	if w.doc.GetMetadata(metaAutoNamed) != nil {
		return
	}
	if w.firstRootUserMessageText() != "" {
		w.doc.SetMetadata(metaAutoNamed, true)
	}
}

// fireAutoName invokes the injected auto-namer and records that it ran, so no
// later message can be mistaken for the conversation's first. See metaAutoNamed.
func (w *ConversationWorker) fireAutoName(firstMessage, provider, model, thinking string, force bool) {
	w.doc.SetMetadata(metaAutoNamed, true)
	w.autoNameFunc(w.conversationID, firstMessage, provider, model, thinking, force)
}

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
