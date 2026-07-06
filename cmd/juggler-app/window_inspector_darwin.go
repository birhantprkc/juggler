//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// enableWebInspector turns on WKWebView's Web Inspector for this window's
// webview, which is what makes the native right-click menu include "Inspect
// Element". We do it from our own cgo (rather than the vendored Wails DevTools
// path) for two reasons: Wails' macOS enableDevTools() is a build-tag no-op in a
// -tags production binary, so it can never enable the inspector at runtime in a
// shipped app; and keeping the tweak here leaves the vendored tree pristine
// across re-vendoring. Same NSWindow-reach-in pattern as paintNativeChrome in
// window_chrome_darwin.go.
//
// The web layer (web/js/services/context-menu-service.js) independently decides
// whether the native menu is shown at all — it preventDefault()s the contextmenu
// event outside dev-mode — so enabling the inspector here only ever surfaces in a
// dev session, where the menu is allowed through.
static void enableWebInspector(void* nsWindow) {
	if (nsWindow == NULL) {
		return;
	}
	NSWindow* window = (__bridge NSWindow*)nsWindow;
	// The WKWebView is a direct subview of the window's content view (added in
	// Wails' windowNew). A drag overlay may sit alongside it, so match by class.
	for (NSView* v in [[window contentView] subviews]) {
		if ([v isKindOfClass:[WKWebView class]]) {
			WKWebView* webView = (WKWebView*)v;
			// developerExtrasEnabled is read by WebKit when it builds the context
			// menu, so setting it any time before a right-click is enough. KVC
			// because the property is not in the public WKPreferences header —
			// this is exactly what Wails' own windowEnableDevTools does.
			[webView.configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
			return;
		}
	}
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// enableWebInspector enables the WKWebView Web Inspector (and thus the native
// menu's "Inspect Element") for win. Call once the window has a native handle
// (after Show). No-op when the handle isn't ready yet.
func enableWebInspector(win *application.WebviewWindow) {
	handle := win.NativeWindow()
	if handle == nil {
		return
	}
	C.enableWebInspector(handle)
}
