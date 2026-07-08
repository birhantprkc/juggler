//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"os"
	"path/filepath"
	"strings"
)

// mergePath unions two PATH-style strings, putting login's entries first and
// de-duplicating by exact string match (case-sensitive, matching how shells
// resolve PATH). Entries from login come first so the merged PATH matches what
// a terminal launch would have produced; anything present only in current is
// appended afterwards so a Juggler-added entry is never lost. Empty entries are
// dropped. Returns the joined result using the platform PATH separator.
func mergePath(current, login string) string {
	var result []string
	seen := make(map[string]bool)
	add := func(path string) {
		for _, entry := range filepath.SplitList(path) {
			entry = strings.TrimSpace(entry)
			if entry == "" || seen[entry] {
				continue
			}
			seen[entry] = true
			result = append(result, entry)
		}
	}
	add(login)
	add(current)
	return strings.Join(result, string(os.PathListSeparator))
}
