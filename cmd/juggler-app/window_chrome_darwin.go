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
