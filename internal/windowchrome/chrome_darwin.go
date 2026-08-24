//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package windowchrome paints a Wails window's native chrome to match the page
// theme, for the two hosts that own windows: the server's test-pool window
// (cmd/juggler/app) and the desktop app (cmd/juggler-app). The Objective-C that
// does it lives here once; each host keeps its own platform files, because what
// they do off macOS genuinely differs (the desktop watches the OS colour scheme
// over D-Bus on Linux; the server does nothing anywhere but macOS).
//
// Callers must invoke these on the main thread: both read and write live
// NSWindow state.
package windowchrome

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

// paintSystemChrome makes the window follow the OS light/dark setting. It clears
// the per-window appearance override that paintNativeChrome installs — that
// override also pins the WKWebView's prefers-color-scheme, so without clearing
// it the page can never observe a change in the OS setting. It then reads the
// resulting effective appearance (which falls back to the app/OS appearance) and
// paints the background to the matching colour, returning 1 when the OS is in
// dark mode and 0 otherwise so the caller can tell the page which theme to show.
static int paintSystemChrome(void* nsWindow, int rDark, int gDark, int bDark, int rLight, int gLight, int bLight) {
    if (nsWindow == NULL) {
        return -1;
    }
    NSWindow* window = (__bridge NSWindow*)nsWindow;
    // Follow the OS: a nil appearance lets effectiveAppearance (and the
    // WKWebView's prefers-color-scheme) track System Settings again.
    [window setAppearance:nil];

    NSAppearanceName match = [window.effectiveAppearance
        bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
    BOOL dark = [match isEqualToString:NSAppearanceNameDarkAqua];

    int r = dark ? rDark : rLight;
    int g = dark ? gDark : gLight;
    int b = dark ? bDark : bLight;
    NSColor* colour = [NSColor colorWithRed:r/255.0 green:g/255.0 blue:b/255.0 alpha:1.0];
    [window setBackgroundColor:colour];
    [window setOpaque:YES];
    return dark ? 1 : 0;
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Apply syncs the native NSWindow chrome (background colour, opacity, titlebar
// appearance) with the page theme. Call it once after window creation and again
// whenever the page theme toggles. No-op when win has no native handle yet.
func Apply(win *application.WebviewWindow, bg application.RGBA) {
	handle := win.NativeWindow()
	if handle == nil {
		return
	}
	C.paintNativeChrome(handle, C.int(bg.Red), C.int(bg.Green), C.int(bg.Blue))
}

// PaintSystem makes the window follow the OS light/dark setting and reports the
// theme that resolves to, along with the matching background colour. It clears
// the forced NSWindow appearance (so the WKWebView's prefers-color-scheme tracks
// System Settings again), then reads the effective appearance to choose between
// the caller's dark and light colours. When the window has no native handle yet
// it falls back to the page's own guess.
func PaintSystem(win *application.WebviewWindow, pageColour application.RGBA, pageTheme string, dark, light application.RGBA) (application.RGBA, string) {
	handle := win.NativeWindow()
	if handle == nil {
		return pageColour, pageTheme
	}
	res := C.paintSystemChrome(handle,
		C.int(dark.Red), C.int(dark.Green), C.int(dark.Blue),
		C.int(light.Red), C.int(light.Green), C.int(light.Blue))
	switch res {
	case 1:
		return dark, "dark"
	case 0:
		return light, "light"
	default: // -1: no native handle at the C layer; keep the page's guess
		return pageColour, pageTheme
	}
}
