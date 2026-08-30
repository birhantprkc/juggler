//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// What a window is for. The role keys the geometry it is placed from — each
// role has its own saved frame in the session — and decides what the workspace
// restores.
//
// A detached board is not in the workspace file, which remembers a window as the
// project it views: two boards on two conversations of one project would be one
// entry, and neither of them is the board it is. A board is restored from the
// project's session instead, where the board itself lives, by the window that
// reopens it — see SessionManager.ClaimDetachedBoards.
//
// Every board is its own role, because every board is a window the user placed:
// see rolePinboardFor.
const (
	roleMain     = "main"
	rolePinboard = "pinboard"
)

// rolePinboardFor names one board's geometry slot. Mirrors
// core.WindowRolePinboardFor, which is what reads the other end of it.
func rolePinboardFor(boardID string) string {
	if boardID == "" {
		return rolePinboard
	}
	return rolePinboard + ":" + boardID
}

// isBoardRole reports whether a role belongs to a detached board, whichever
// board it is. Everything that asks is asking about boards in general — whether
// to skip one when focusing, whether to let one close, whether to remember one —
// and none of it cares which.
func isBoardRole(role string) bool {
	return role == rolePinboard || strings.HasPrefix(role, rolePinboard+":")
}

// viewPinboard is the page's own name for the reduced shell, matching
// web/js/utils/view-mode.js. An empty view is the ordinary app.
const viewPinboard = "pinboard"

// idPattern is the alphabet the server accepts for a viewer id (see
// sanitiseViewerID in cmd/juggler/server/network.go), applied to the ids handed
// to a window here so a junk one yields nothing rather than something nothing
// can reach.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// windowOpts is everything a new window inherits from whatever opened it.
//
// Three of these travelled as positional arguments through openWindowForProject,
// openWindow and buildWindow, which was tolerable at three and is not at six.
// The struct is what stops the next one being threaded through four signatures
// by hand — and what stops a caller passing theme where mode was meant.
type windowOpts struct {
	// theme is the concrete first-frame colour the page paints before it reads
	// its own preference; mode is the opener's *selected* mode, carried so a
	// 'system' parent hands 'system' to its child rather than collapsing to
	// whatever it currently resolves to.
	theme string
	mode  string

	// zoom is the opener's root font-size percentage. It only seeds a child
	// whose project session has no saved zoom of its own — the page gives that
	// priority.
	zoom int

	// view names the shell the page builds: empty for the app, viewPinboard for
	// a board detached into a window of its own. board is the composition that
	// window is — its own tabs, arranged its own way — and conversation is the
	// one it is a view of; together they are the whole of what makes two boards
	// show different things. pin is the tab it opens on. owner is the viewer a
	// reveal from the board is sent to, which is the window it was detached from.
	view         string
	board        string
	owner        string
	pin          string
	conversation string

	// openedBy is the id of the window that asked for this one. It is not read
	// from the query — a page cannot name a window other than its own — but
	// filled in by the control endpoint, which knows which window the request
	// arrived on. Only a detached board carries one: it is how the app knows
	// which boards go with a window when it closes.
	openedBy string
}

// role reports which geometry slot and which restore rules this window follows.
//
// Each board has a slot of its own. Two boards are two windows the user placed
// somewhere on purpose, and one shared slot had the second one opened land on
// top of the first, and the last one closed decide where every board opened
// next time.
func (o windowOpts) role() string {
	if o.view == viewPinboard {
		return rolePinboardFor(o.board)
	}
	return roleMain
}

// isPinboard reports whether this window is a detached board rather than the app.
func (o windowOpts) isPinboard() bool { return o.view == viewPinboard }

// windowOptsFromQuery reads the hand-off a page POSTed to /win/<id>/new. Every
// field is validated here rather than trusted: the request arrives over a
// loopback listener that any same-host process can reach, and an unvalidated
// view or id would be baked straight into the child's URL.
func windowOptsFromQuery(q url.Values) windowOpts {
	zoom, _ := strconv.Atoi(q.Get("zoom"))
	opts := windowOpts{
		theme: q.Get("theme"),
		mode:  q.Get("mode"),
		zoom:  zoom,
	}
	if q.Get("view") == viewPinboard {
		opts.view = viewPinboard
		opts.board = normaliseID(q.Get("board"))
		opts.owner = normaliseID(q.Get("owner"))
		opts.pin = normaliseID(q.Get("pin"))
		opts.conversation = normaliseID(q.Get("conversation"))
	}
	return opts
}

// normaliseID accepts an id the page supplied, or returns empty for anything
// that is not one.
func normaliseID(id string) string {
	if idPattern.MatchString(id) {
		return id
	}
	return ""
}

// windowPageURL is the page a window opens on: the server it views, the loopback
// control endpoint addressed to this window, and the hand-off hints. Only
// non-empty hints are sent, so a first-ever launch with nothing to inherit still
// lets the page follow its own precedence.
//
// Pure, so the query it builds can be asserted without a native window.
func windowPageURL(serverURL, nativeCtl string, opts windowOpts) string {
	u := strings.TrimRight(serverURL, "/") + "/?window=1&nativeCtl=" + url.QueryEscape(nativeCtl)
	if opts.theme != "" {
		u += "&theme=" + url.QueryEscape(opts.theme)
	}
	if opts.mode != "" {
		u += "&mode=" + url.QueryEscape(opts.mode)
	}
	if opts.zoom > 0 {
		u += "&zoom=" + strconv.Itoa(opts.zoom)
	}
	if opts.view != "" {
		u += "&view=" + url.QueryEscape(opts.view)
		if opts.board != "" {
			u += "&board=" + url.QueryEscape(opts.board)
		}
		if opts.owner != "" {
			u += "&owner=" + url.QueryEscape(opts.owner)
		}
		if opts.pin != "" {
			u += "&pin=" + url.QueryEscape(opts.pin)
		}
		if opts.conversation != "" {
			u += "&conversation=" + url.QueryEscape(opts.conversation)
		}
	}
	return u
}
