// Main-thread liveness probe and macOS sleep/wake observers.
//
// WebKit has a lock-ordering bug in its CVDisplayLink path: the DisplayLink
// IO callback can call CVDisplayLink::stop() from inside its own callback
// while holding WebKit::DisplayLink's lock, deadlocking against the main
// thread when it tries to addObserver. It is reached whenever the display
// configuration changes under a live DisplayLink — a screen powering on or
// off, a monitor attached, a system wake. We can't fix WebKit, but we CAN
// detect that the main thread has stopped pumping its run loop and recover.
//
// The hidden engine WKWebView is configured with KeepRunningWhenHidden
// disabled (WKInactiveSchedulingPolicyThrottle, engine_lifecycle.go), which
// is meant to keep it off that path entirely; the test pool's visible windows
// opt back in with Policy None. That mitigation is not the whole story —
// wedges have been recorded on servers running the throttled configuration —
// so this watchdog is load-bearing, not belt-and-braces.
//
// juggler_mainthread_pong_counter() returns an atomic counter that is
// incremented by a block dispatched to the main queue. The Go watchdog
// captures it, calls juggler_mainthread_ping(), waits, and re-reads. If it
// did not advance, the main thread is wedged.
//
// juggler_register_sleepwake_observers() wires NSWorkspace notifications to
// Go-side callbacks so the watchdog can expedite its next check, and forgive a
// stall, after the system wakes.
//
// It observes SYSTEM sleep/wake only. A Mac that never sleeps — one held awake
// by a power assertion, which is the common desktop case — powers its screens
// down and up without posting either notification, so the grace window does not
// arm for a display wake even though that is the same DisplayLink
// reconfiguration. NSWorkspaceScreensDidSleep/DidWakeNotification are the pair
// that would cover it; they are deliberately not observed yet, because
// forgiving those stalls would also stop the sampler
// (mainthread_sample_darwin.go) capturing the stacks that say what is actually
// deadlocking.

#import <AppKit/AppKit.h>
#import <stdatomic.h>

extern void jugglerOnWillSleep(void);
extern void jugglerOnDidWake(void);

static _Atomic unsigned long long g_mainthread_pong = 0;

void juggler_mainthread_ping(void) {
    // dispatch_async to the main queue: if the main thread is pumping its
    // run loop normally, this block executes within milliseconds. If the
    // main thread is wedged inside a lock (WebKit deadlock, anything in C
    // that holds Cocoa hostage, etc.), the block never runs and the
    // counter stays put.
    dispatch_async(dispatch_get_main_queue(), ^{
        atomic_fetch_add_explicit(&g_mainthread_pong, 1, memory_order_relaxed);
    });
}

unsigned long long juggler_mainthread_pong_counter(void) {
    return atomic_load_explicit(&g_mainthread_pong, memory_order_relaxed);
}

void juggler_register_sleepwake_observers(void) {
    NSNotificationCenter *nc = [[NSWorkspace sharedWorkspace] notificationCenter];
    [nc addObserverForName:NSWorkspaceWillSleepNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *note) {
        (void)note;
        jugglerOnWillSleep();
    }];
    [nc addObserverForName:NSWorkspaceDidWakeNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *note) {
        (void)note;
        jugglerOnDidWake();
    }];
}

// App Nap defeat lives in the osactivity package now: it's per-request,
// refcounted, and scoped to active work rather than always-on.
