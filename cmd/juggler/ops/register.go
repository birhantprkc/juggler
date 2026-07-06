//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

// RegisterAll wires every built-in operation handler into the package-global
// registry and starts the background goroutines that own shared state
// (shell registry, webfetch cache). Call exactly once at process startup;
// tests that want a subset compose their own ops.Register(...) calls instead.
func RegisterAll() {
	Register("read-file", func(scope PathScope) Operations {
		return NewFileOperations(scope)
	})
	Register("tree", func(scope PathScope) Operations {
		return NewTreeOperations(scope)
	})
	Register("grep", func(scope PathScope) Operations {
		return NewSearchOperations(scope)
	})
	Register("python", func(scope PathScope) Operations {
		return NewShellOperations(scope)
	})
	Register("shell", func(scope PathScope) Operations {
		return NewShellOperations(scope)
	})
	Register("os", func(scope PathScope) Operations {
		return NewOSOperations(scope)
	})
	Register("webfetch", func(scope PathScope) Operations {
		return NewWebFetchOperations(scope)
	})
	Register("websearch", func(scope PathScope) Operations {
		return NewWebSearchOperations(scope)
	})

	go runShellRegistry()
	go cacheManager()
}
