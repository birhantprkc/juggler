//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>

// paintNativeChrome syncs the NSWindow to a theme colour:
//
//   - NSWindow background + opaque flag → fills the strip exposed during a
//     live resize. Wails v3's WebviewWindow constructor leaves every window
//     non-opaque with clearColor (intended for transparent backdrops); we
//     override that here so AppKit paints the gap with our colour instead
//     of blending with the desktop.
//   - NSWindow appearance (DarkAqua / Aqua, chosen by luma) → repaints the
//     traffic-light buttons in the matching style.
//
// The strip behind the transparent titlebar is painted by the HTML canvas,
// which is updated from JS (see theme-manager.js) — WebKit caches the
// canvas colour from CSS at first paint and won't refresh from CSS variable
// changes, so we set an inline style on <html> there rather than try to
// touch it from native code.
//
// Note: WKWebView.drawsBackground was removed in macOS 26; the NSWindow
// background colour above is sufficient to fill resize gaps.
static void paintNativeChrome(void* nsWindow, int r, int g, int b) {
    if (nsWindow == NULL) {
        return;
    }
    NSWindow* window = (__bridge NSWindow*)nsWindow;
    NSColor* colour = [NSColor colorWithRed:r/255.0 green:g/255.0 blue:b/255.0 alpha:1.0];

    [window setBackgroundColor:colour];
    [window setOpaque:YES];

    double luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
    NSString* name = (luma < 0.5) ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua;
    [window setAppearance:[NSAppearance appearanceNamed:name]];
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// applyWindowChrome syncs the native NSWindow chrome (background colour,
// opacity, titlebar appearance) with the page theme.
// Call it once after window creation and again whenever the page theme
// toggles. No-op when win has no native handle yet.
func applyWindowChrome(win *application.WebviewWindow, bg application.RGBA) {
	handle := win.NativeWindow()
	if handle == nil {
		return
	}
	C.paintNativeChrome(handle, C.int(bg.Red), C.int(bg.Green), C.int(bg.Blue))
}
