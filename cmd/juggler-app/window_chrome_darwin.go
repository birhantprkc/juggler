//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>

// paintNativeChrome syncs the NSWindow to a theme colour (background + opacity
// to fill the strip exposed during a live resize, and the DarkAqua/Aqua
// appearance so the traffic-light buttons match). See the server-side twin in
// cmd/juggler/window_chrome_darwin.go for the full rationale; this is a copy so
// the desktop-app binary can repaint its own windows without a shared cgo
// package.
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

// applyWindowChrome syncs the native NSWindow chrome with the page theme. Call
// it once after window creation and again on every theme toggle. No-op when win
// has no native handle yet.
func applyWindowChrome(win *application.WebviewWindow, bg application.RGBA) {
	handle := win.NativeWindow()
	if handle == nil {
		return
	}
	C.paintNativeChrome(handle, C.int(bg.Red), C.int(bg.Green), C.int(bg.Blue))
}

// paintSystemChrome makes the window follow the OS light/dark setting and
// reports the theme that resolves to. It clears the forced NSWindow appearance
// (so the WKWebView's prefers-color-scheme tracks System Settings again), then
// reads the effective appearance to pick the background colour and theme name.
// When the window has no native handle yet it falls back to the page's guess.
// Must run on the main thread. See control.go's "system" theme branch.
func paintSystemChrome(win *application.WebviewWindow, pageColour application.RGBA, pageTheme string) (application.RGBA, string) {
	handle := win.NativeWindow()
	if handle == nil {
		return pageColour, pageTheme
	}
	dark, light := themeColours["dark"], themeColours["light"]
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

// watchSystemColorScheme is Linux-only: on macOS "system" mode clears the forced
// NSWindow appearance, so the WKWebView's prefers-color-scheme tracks System
// Settings and the page's own matchMedia 'change' listener follows live toggles.
// No-op here.
func (a *appState) watchSystemColorScheme() {}
