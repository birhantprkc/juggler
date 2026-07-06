// Refcounted NSProcessInfo activity assertion.
//
// All mutation is serialised on a private dispatch queue so the refcount
// and the activity-token pointer can't be torn by concurrent Begin/End
// calls from arbitrary goroutines. We use dispatch_sync from the
// caller's thread (not the main queue — that would deadlock with the
// WebKit-wedge case we exist to mitigate).
//
// NSActivityUserInitiatedAllowingIdleSystemSleep: blocks App Nap and
// sudden termination, but does NOT prevent system sleep when the user
// closes the lid. That's the right tradeoff for an active LLM request:
// we want full CPU while it runs, but we don't want to hold the whole
// machine awake.

#import <Foundation/Foundation.h>

static dispatch_queue_t g_q = NULL;
static id g_token = nil;
static int g_refcount = 0;

static void ensure_queue(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_q = dispatch_queue_create("studio.juggler.activity",
                                    DISPATCH_QUEUE_SERIAL);
    });
}

void juggler_activity_begin(void) {
    ensure_queue();
    dispatch_sync(g_q, ^{
        g_refcount++;
        if (g_refcount == 1) {
            NSActivityOptions opts = NSActivityUserInitiatedAllowingIdleSystemSleep;
            // Under ARC, assigning to a strong global retains.
            g_token = [[NSProcessInfo processInfo]
                beginActivityWithOptions:opts
                                  reason:@"Juggler is processing a user request"];
        }
    });
}

void juggler_activity_end(void) {
    ensure_queue();
    dispatch_sync(g_q, ^{
        if (g_refcount == 0) {
            // Defensive: an unpaired End shouldn't crash the process.
            return;
        }
        g_refcount--;
        if (g_refcount == 0 && g_token != nil) {
            [[NSProcessInfo processInfo] endActivity:g_token];
            g_token = nil;
        }
    });
}
