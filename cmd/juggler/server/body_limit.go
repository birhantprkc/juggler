//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "net/http"

// defaultMaxBodyBytes caps incoming request bodies. Generous enough for file
// uploads (large patches, screenshots) but small enough that a malicious or
// stuck client cannot pin server memory by sending an unbounded stream.
const defaultMaxBodyBytes = 32 << 20 // 32 MiB

// withBodyLimit wraps a handler so every request reads at most n bytes of
// body. WebSocket upgrades are exempt — the upgrader hijacks the connection
// and any further reads bypass the http.Request body. The "Upgrade: websocket"
// header is the standard way to detect that case before the upgrade happens.
func withBodyLimit(next http.Handler, n int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "websocket" && r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, n)
		}
		next.ServeHTTP(w, r)
	})
}
