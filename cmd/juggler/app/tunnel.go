//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server"
)

// printTunnelStatus prints the active tunnel's URL and QR code to the terminal,
// with the title and note the mode's registered spec declares.
func printTunnelStatus(info server.TunnelInfo) {
	title, note := "WAN ACCESS ACTIVE", ""
	for _, spec := range server.TunnelModes() {
		if spec.Mode == info.Mode {
			if spec.StatusTitle != "" {
				title = spec.StatusTitle
			}
			note = spec.StatusNote
			break
		}
	}
	content := info.URL
	if note != "" {
		content += "\n\n" + note
	}
	core.PrintProminentBox(title, content, core.ColorMagenta)
	core.PrintQRCode(info.URL)
}
