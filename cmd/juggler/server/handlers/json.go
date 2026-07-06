//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"

	"juggler/internal/jlog"
)

// WriteJSON writes v as a JSON response. If status is non-zero it is written
// via WriteHeader before the body; status == 0 leaves the default 200 / any
// status the caller already set. Encode failures are logged (the response is
// already partially flushed at that point so there is nothing more to do).
func WriteJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	if status != 0 {
		w.WriteHeader(status)
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		path := ""
		if r != nil {
			path = r.URL.Path
		}
		jlog.Error("writeJSON: encode failed for %s: %v", path, err)
	}
}

// writeJSON is the package-internal alias other handler files use.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	WriteJSON(w, r, status, v)
}

// writeError sends a consistent JSON error envelope, {"error": msg}, with the
// given status. Handlers use this so every error response shares one shape the
// frontend reads via the "error" field.
func writeError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	writeJSON(w, r, status, map[string]string{"error": msg})
}
