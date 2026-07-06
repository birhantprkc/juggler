//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"

	"juggler/internal/jlog"
)

// handleClientReport is the frontend → application-log bridge. The desktop app's
// WebView console (and the engine's hidden worker WebView console) can't be read
// in a shipped build, so a fault a real user hits would otherwise vanish — this
// endpoint lands it in the app log they can send us. Two callers use it:
//   - the worker-backed engine runtime (web/js/engine-worker-runtime.js), which
//     reports its boot outcome; it predates the generic bridge, so an omitted (or
//     "engine") source keeps its original, descriptive wording.
//   - the viewer's chime path (web/js/utils/chime-synth.js), which reports the
//     rare untoward audio events (a wedged/rebuilt context, a resume that never
//     recovers, a fresh context that comes up interrupted, no Web Audio at all)
//     tagged source "chime".
//
// Body: {source?, event?, message?, stack?}. event "error" logs at Error,
// "ready" at Info, anything else at Debug. Callers send only untoward events, so
// the app log stays quiet unless something actually went wrong.
func (s *Server) handleClientReport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source  string `json:"source"`
		Event   string `json:"event"`
		Message string `json:"message"`
		Stack   string `json:"stack"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	// The engine runtime's boot telemetry keeps its original wording verbatim.
	if body.Source == "" || body.Source == "engine" {
		switch body.Event {
		case "ready":
			jlog.Info("[engine] worker runtime ready")
		case "error":
			jlog.Error("[engine] worker runtime error: %v\nstack: %v", body.Message, body.Stack)
		default:
			jlog.Debug("[engine] worker runtime report: %v", body.Event)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Any other source (e.g. the chime path) logs generically, tagged by source.
	// Both strings are client-supplied and land verbatim in the app log, so bound
	// them defensively.
	source, msg := body.Source, body.Message
	if len(source) > 32 {
		source = source[:32]
	}
	if len(msg) > 500 {
		msg = msg[:500]
	}
	if body.Event == "error" {
		jlog.Error("[%s] %s", source, msg)
	} else {
		jlog.Info("[%s] %s", source, msg)
	}
	w.WriteHeader(http.StatusNoContent)
}
