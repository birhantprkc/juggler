//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
)

// Window geometry lives with the session it applies to, server-side: the server
// stores it in the current project's session (via /api/session/window-state), so
// it is per-project and travels with the session. The desktop app is just a
// conduit: it reads the saved frame when opening a window and writes the frame
// back as the user moves/resizes it.
//
// Each window ROLE gets its own slot in that session. A project has never had
// only one window — a second one for the same project already cascades off the
// first — and a board detached into a window of its own is a different shape
// from the app entirely, so one shared frame would have each kind of window
// overwriting the other's on close.

var windowStateHTTP = &http.Client{Timeout: 4 * time.Second}

// windowStateURL addresses one role's saved frame in the server's current
// session.
func windowStateURL(serverURL, role string) string {
	return strings.TrimRight(serverURL, "/") + "/api/session/window-state?role=" + url.QueryEscape(role)
}

// fetchWindowState reads the saved geometry for the project the server is
// currently serving. Returns (zero, false) when nothing is saved or the server
// can't be reached — the caller then uses a default placement.
//
// A freshly spawned server prints its address before it starts accepting
// connections, so the first few requests can fail on connection refused; we
// retry transport errors briefly. A response (even non-200) is authoritative
// and ends the loop.
func fetchWindowState(serverURL, role string) (core.WindowState, bool) {
	url := windowStateURL(serverURL, role)
	const attempts = 30
	for i := 0; i < attempts; i++ {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
		if err != nil {
			return core.WindowState{}, false
		}
		resp, err := windowStateHTTP.Do(req)
		if err != nil {
			// Server not accepting yet — back off and retry.
			time.Sleep(100 * time.Millisecond)
			continue
		}
		ws, ok := decodeWindowState(resp)
		return ws, ok
	}
	return core.WindowState{}, false
}

func decodeWindowState(resp *http.Response) (core.WindowState, bool) {
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return core.WindowState{}, false
	}
	var body struct {
		WindowState core.WindowState `json:"windowState"`
		HasState    bool             `json:"hasState"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return core.WindowState{}, false
	}
	return body.WindowState, body.HasState
}

// putWindowState persists geometry into the session the server is currently
// serving. Best-effort: errors are ignored (the window still works; we just
// didn't record this frame).
func putWindowState(serverURL, role string, ws core.WindowState) {
	url := windowStateURL(serverURL, role)
	data, err := json.Marshal(ws)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := windowStateHTTP.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

// forgetBoard tells the server the board a window held is finished with, which
// drops its tabs and the frame it was in.
//
// Called when a board window is closed on its own, and only then. A board taken
// down with the window that opened it, or with the app, keeps everything: it is
// a window that will be opened again, and what it held is what it opens with.
//
// Best-effort, like the geometry writes it sits beside. A board that outlives a
// close it should not have costs the user one stale window next launch, which is
// a great deal better than a race here losing an arrangement they still wanted.
func forgetBoard(serverURL, boardID string) {
	if boardID == "" {
		return
	}
	endpoint := strings.TrimRight(serverURL, "/") +
		"/api/session/pinboard/boards?board=" + url.QueryEscape(boardID)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete, endpoint, nil)
	if err != nil {
		return
	}
	resp, err := windowStateHTTP.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}
