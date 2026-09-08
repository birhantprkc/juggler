//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build linux && !production && !gtk3

package app

/*
#cgo linux pkg-config: gtk4 webkitgtk-6.0

#include <gtk/gtk.h>
#include <webkit/webkit.h>

// WebKitGTK snaps a hidden page's DOM timer due times to a 1s grid, exactly as
// the Cocoa port does: HiddenPageDOMTimerThrottlingEnabled defaults to true for
// PLATFORM(COCOA) || PLATFORM(GTK), and a timer that has reached its nesting
// limit — every self-rescheduling chain, which is what a UI flow and the suite
// driving it are made of — is then aligned to the next second. A suite is
// priced in the number of ticks it waits out rather than in the work it does:
// the pinboard suites make ~85 timer calls and run in under a second on an
// unthrottled pool, and in 58s on a throttled one.
//
// A page is hidden on this port whenever its widget is unmapped
// (webkitWebViewBaseUpdateVisibility is gtk_widget_get_mapped plus toplevel
// state), and the pool window is deliberately never shown, so the pool is
// permanently a hidden page and there is no visibility to win back.
//
// There is no C setter and no environment variable for the preference. The one
// switch is the runtime feature list, where every exposed boolean preference
// appears under an identifier the generator makes by stripping a trailing
// "Enabled" — so HiddenPageDOMTimerThrottlingEnabled is asked for as
// "HiddenPageDOMTimerThrottling". The list is walked rather than searched
// because webkit_feature_list_find() is newer than the API itself.

// findWebView returns the first WebKitWebView in a widget tree. Wails owns the
// web view and exposes only the GtkWindow, so the widget hierarchy is the seam
// available to us; the window holds a box, and the box holds the one web view.
static WebKitWebView* findWebView(GtkWidget* widget) {
	if (widget == NULL) {
		return NULL;
	}
	if (WEBKIT_IS_WEB_VIEW(widget)) {
		return WEBKIT_WEB_VIEW(widget);
	}
	for (GtkWidget* child = gtk_widget_get_first_child(widget);
	     child != NULL;
	     child = gtk_widget_get_next_sibling(child)) {
		WebKitWebView* found = findWebView(child);
		if (found != NULL) {
			return found;
		}
	}
	return NULL;
}

// sizeHiddenPoolWebView gives the pool window's web view an allocation of its
// own. Returns 0 when there is no web view yet, or when the allocation did not
// take, so the caller can say so rather than silently running the pool in a
// page of no size.
//
// GTK sizes a widget during a layout pass, and a layout pass is driven by the
// toplevel's frame clock, which only runs once the window is mapped. The pool
// window is never mapped, so nothing ever measures or allocates anything in it:
// the web view stays 0x0, the WebPage it backs stays 0x0, and every lane inside
// lays its DOM out in a page 0 pixels wide, where every rect is empty and
// anything measured is measured as zero.
//
// A zero-sized page is also what throttles the lanes' clocks, by a mechanism no
// preference reaches. WebCore takes a frame with a box that intersects nothing
// visible for one nobody can see and coarsens its timers to a 1s grid
// (LocalFrameView::updateScriptedAnimationsAndTimersThrottlingState):
//
//	// We don't throttle zero-size or display:none frames because those are usually utility frames.
//	bool shouldThrottle = visibleRect.isEmpty() && !m_size.isEmpty() && frame().ownerRenderer();
//
// An unallocated window has an empty visible rect, so a lane iframe is exempt
// only while it has no size at all, and a page a lane can lay out in and a lane
// clock that ticks in milliseconds are the same fix: give the view a size and
// the visible rect it feeds is no longer empty.
//
// gtk_widget_allocate() is the one lever the GTK port exposes for this — there
// is no view-size or exposed-rect setter on it — and it neither requires nor
// asks about mapping: it walks past invisible widgets, and the web view is
// visible even though the window it sits in is not. The measure calls ahead of
// it are what a parent would have done, and keep a debug build from warning
// about a size that arrived without one.
static int sizeHiddenPoolWebView(void* gtkWindow, int width, int height) {
	if (gtkWindow == NULL || width <= 0 || height <= 0) {
		return 0;
	}
	WebKitWebView* webView = findWebView(GTK_WIDGET(gtkWindow));
	if (webView == NULL) {
		return 0;
	}
	GtkWidget* widget = GTK_WIDGET(webView);
	if (gtk_widget_get_width(widget) < width || gtk_widget_get_height(widget) < height) {
		int minimum = 0, natural = 0;
		gtk_widget_measure(widget, GTK_ORIENTATION_HORIZONTAL, -1, &minimum, &natural, NULL, NULL);
		gtk_widget_measure(widget, GTK_ORIENTATION_VERTICAL, width, &minimum, &natural, NULL, NULL);
		gtk_widget_allocate(widget, width, height, -1, NULL);
	}
	return gtk_widget_get_width(widget) >= width && gtk_widget_get_height(widget) >= height;
}

#if WEBKIT_CHECK_VERSION(2, 42, 0)

// unthrottleHiddenPageTimers switches the alignment off for one window's web
// view. Returns 0 when there is no web view to configure or the preference is
// not in the feature list, so the caller can say so rather than silently
// running a throttled pool.
static int unthrottleHiddenPageTimers(void* gtkWindow) {
	if (gtkWindow == NULL) {
		return 0;
	}
	WebKitWebView* webView = findWebView(GTK_WIDGET(gtkWindow));
	if (webView == NULL) {
		return 0;
	}
	WebKitSettings* settings = webkit_web_view_get_settings(webView);
	if (settings == NULL) {
		return 0;
	}
	WebKitFeatureList* features = webkit_settings_get_all_features();
	if (features == NULL) {
		return 0;
	}
	int found = 0;
	for (gsize i = 0, n = webkit_feature_list_get_length(features); i < n; i++) {
		WebKitFeature* feature = webkit_feature_list_get(features, i);
		const char* identifier = webkit_feature_get_identifier(feature);
		// The companion auto-increase escalates a long-hidden page's grid from
		// 1s upwards. It is off by default on this port, but leaving it armed
		// would re-throttle a page that somehow re-enabled the first.
		if (g_strcmp0(identifier, "HiddenPageDOMTimerThrottling") == 0) {
			webkit_settings_set_feature_enabled(settings, feature, FALSE);
			found = 1;
		} else if (g_strcmp0(identifier, "HiddenPageDOMTimerThrottlingAutoIncreases") == 0) {
			webkit_settings_set_feature_enabled(settings, feature, FALSE);
		}
	}
	webkit_feature_list_unref(features);
	return found;
}

#else

// The feature list arrived in WebKitGTK 2.42. An older library leaves the
// throttled default in place instead of failing to build.
static int unthrottleHiddenPageTimers(void* gtkWindow) {
	(void)gtkWindow;
	return 0;
}

#endif
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
// This lives here rather than in the vendored Wails fork for the same reasons
// the macOS one does: the switch serves the test pool alone, and the fork is
// kept as a rebaseable series of patches upstream could take.
//
// Must run on the main thread, after the window's web view exists — it walks
// live GTK widget state. The preference is re-read by WebCore when it changes,
// so setting it on a window that has already loaded is enough.
func unthrottleHiddenPageTimers(win *application.WebviewWindow) bool {
	handle := win.NativeWindow()
	if handle == nil {
		return false
	}
	return C.unthrottleHiddenPageTimers(handle) != 0
}

// ensureHiddenPoolWebViewSized gives the pool window's web view the size the
// window was asked for, which GTK never assigns it because the window is never
// mapped. Reports whether the view came away with that size.
//
// A page of no size is two faults at once: the lanes in it measure nothing, and
// each lane with a box in an unallocated page has its timers aligned to a 1s
// grid — see sizeHiddenPoolWebView above for the WebCore condition that decides
// the second.
//
// Must run on the main thread, after the window's web view exists — it measures
// and allocates live GTK widgets. Sizing a view whose page has already loaded is
// enough: the size reaches the web process as a geometry update, which lays the
// page out again at the new one.
func ensureHiddenPoolWebViewSized(win *application.WebviewWindow, width, height int) bool {
	handle := win.NativeWindow()
	if handle == nil {
		return false
	}
	return C.sizeHiddenPoolWebView(handle, C.int(width), C.int(height)) != 0
}
