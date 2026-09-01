//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin && !production

package app

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// WebKit snaps a hidden page's DOM timer due times to a ~1s grid, which is a
// different mechanism from the scheduling policy that decides whether a hidden
// page runs at all: measured on the test pool, a `setTimeout(fn, 10)` takes
// 912ms with the alignment on and 12ms with it off. Zero-delay timers are
// exempt, so what it taxes is every debounce, retry and deferred refresh in the
// code under test — each step of a UI flow waits out a grid tick.
//
// The switch is WebKit SPI, so it is declared here rather than imported, and
// sent only behind -respondsToSelector: — a WebKit that drops it leaves the
// throttled default in place instead of raising.
@interface WKPreferences (JugglerHiddenPageTimers)
- (void)_setHiddenPageDOMTimerThrottlingEnabled:(BOOL)enabled;
- (void)_setHiddenPageDOMTimerThrottlingAutoIncreasesEnabled:(BOOL)enabled;
@end

// findWebView returns the first WKWebView in a view tree. Wails owns the
// WKWebView and exposes only the NSWindow, so the view hierarchy is the seam
// available to us; the window hosts exactly one web view.
static WKWebView* findWebView(NSView* view) {
	if ([view isKindOfClass:[WKWebView class]]) {
		return (WKWebView*)view;
	}
	for (NSView* sub in view.subviews) {
		WKWebView* found = findWebView(sub);
		if (found != nil) {
			return found;
		}
	}
	return nil;
}

// unthrottleHiddenPageTimers switches the alignment off for one window's web
// view. Returns 0 when there is no web view to configure or the SPI is gone, so
// the caller can say so rather than silently running a throttled pool.
static int unthrottleHiddenPageTimers(void* nsWindow) {
	if (nsWindow == NULL) {
		return 0;
	}
	NSWindow* window = (__bridge NSWindow*)nsWindow;
	WKWebView* webView = findWebView(window.contentView);
	if (webView == nil) {
		return 0;
	}
	WKPreferences* prefs = webView.configuration.preferences;
	if (![prefs respondsToSelector:@selector(_setHiddenPageDOMTimerThrottlingEnabled:)]) {
		return 0;
	}
	[prefs _setHiddenPageDOMTimerThrottlingEnabled:NO];
	// The companion auto-increase escalates a long-hidden page's grid from 1s
	// toward 30s. Switching the alignment off makes it moot, but leaving it
	// armed would re-throttle any page that somehow re-enabled the first.
	if ([prefs respondsToSelector:@selector(_setHiddenPageDOMTimerThrottlingAutoIncreasesEnabled:)]) {
		[prefs _setHiddenPageDOMTimerThrottlingAutoIncreasesEnabled:NO];
	}
	return 1;
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// unthrottleHiddenPageTimers stops the test pool's hidden window coarsening the
// timers of the code under test, so a suite is priced in the work it does
// rather than in the number of timer ticks it waits out. Reports whether it
// took effect.
//
// This lives here, in a `!production` file, rather than in the vendored Wails
// fork, for two reasons. The selector strings are compiled in wherever the
// category is declared, whether or not anything sends them, so declaring it in
// Wails would put private WebKit SPI in every shipped Juggler binary (and, were
// it ever upstreamed, in every Wails app) for a benefit only the test pool
// sees. And the fork is kept as a rebaseable series of patches that upstream
// could take; a permanently un-upstreamable one is a tax on every future
// rebase.
//
// Must run on the main thread, after the window's web view exists — it reads
// live NSWindow state. Unlike the scheduling policy, which WebKit reads once at
// navigation time, this preference propagates to the web process when it
// changes, so setting it on a window that has already loaded is enough.
func unthrottleHiddenPageTimers(win *application.WebviewWindow) bool {
	handle := win.NativeWindow()
	if handle == nil {
		return false
	}
	return C.unthrottleHiddenPageTimers(handle) != 0
}
