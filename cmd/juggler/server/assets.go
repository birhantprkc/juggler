//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io"
	"net/http"
	"strings"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/worker"
)

// maxAssetUploadBytes caps an uploaded attachment. The raw bytes are the request
// body, so this bounds memory per upload.
const maxAssetUploadBytes = 25 << 20 // 25 MiB

// handleUploadAsset accepts the raw image bytes as the request body (mime in the
// Content-Type header), stores them content-addressed via worker.AssetStore, and
// returns the resulting AssetRef as JSON. Lives in the server package (not
// handlers) because it needs worker.AssetStore, which handlers must not import.
func (s *Server) handleUploadAsset(w http.ResponseWriter, r *http.Request) {
	convID := mux.Vars(r)["convId"]
	if convID == "" {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Missing conversation id"})
		return
	}

	contentType := r.Header.Get("Content-Type")
	if mediaType, _, ok := strings.Cut(contentType, ";"); ok {
		contentType = strings.TrimSpace(mediaType)
	}
	if !strings.HasPrefix(contentType, "image/") {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Only image/* uploads are accepted"})
		return
	}

	// Same path-provider pattern as createLLMCaller: the asset store resolves the
	// per-conversation folder via the session manager, knowing nothing about the
	// project layout.
	assetStore := worker.NewAssetStore(func(id string) (string, bool) {
		sm := s.SessionManager()
		if sm == nil {
			return "", false
		}
		return sm.ConvDir(id)
	})

	r.Body = http.MaxBytesReader(w, r.Body, maxAssetUploadBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Upload too large or read failed"})
		return
	}
	if len(data) == 0 {
		handlers.WriteJSON(w, r, http.StatusBadRequest, map[string]string{"error": "Empty upload"})
		return
	}

	ref, err := assetStore.Save(convID, data, contentType)
	if err != nil {
		handlers.WriteJSON(w, r, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	handlers.WriteJSON(w, r, http.StatusOK, ref)
}
