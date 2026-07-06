//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	provider "juggler/cmd/juggler/providers/registry"
)

// init starts the model-info cache actor. Per-conversation session state
// lives on each *Client (bound 1:1 to a Conversation by the server's
// conversationCache); Cancel/Close on the Conversation handle do the
// lifecycle work directly.
func init() {
	go runModelInfoActor()
}

// Register adds this provider to the global registry. Lifecycle (cancel,
// close, shutdown) is handled per-conversation through the Conversation
// handle returned by OpenConversation; the server's
// conversationCache.Shutdown closes every live handle on its way out.
func Register() {
	provider.RegisterProvider(Info(), NewClient)
}
