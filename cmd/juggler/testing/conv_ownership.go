//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package testing

import "fmt"

// ConvOwnership is the test-mode conversation ownership ledger. In the
// multi-lane browser-test pool every lane shares ONE server session, so the
// safety boundary for destructive operations is "which lane created this
// conversation". Each create tagged with a lane records ownership here; the
// delete/bin handlers consult CheckDelete before tearing the worker down, so
// a cross-lane delete — which would freeze the victim lane's in-flight test —
// is rejected at the API boundary instead of depending on every JS call site
// behaving. Conversations created without a lane tag (bootstrap convs,
// worker-side duplicates, production paths) are unowned and unprotected.
//
// At suite end Dump() lists every still-owned conversation: each one is a
// test that leaked a conversation it created, named by its lane's last
// recorded reason. The Go harness fails the run on a non-empty dump so leaks
// stay loud instead of silently marching the shared session toward the
// MAX_CONVERSATIONS cap.
//
// A single goroutine owns the map; all access routes through ops (no mutex,
// per the project concurrency rule).
type ConvOwnership struct {
	ops chan ownerOp
}

type ownerOpKind int

const (
	ownerRecord ownerOpKind = iota
	ownerRelease
	ownerCheck
	ownerDump
	ownerStop
)

type ownerOp struct {
	kind   ownerOpKind
	convID string
	lane   string
	errOut chan error
	mapOut chan map[string]string
}

// NewConvOwnership creates a ledger and starts its actor goroutine.
func NewConvOwnership() *ConvOwnership {
	o := &ConvOwnership{ops: make(chan ownerOp, 64)}
	go o.run()
	return o
}

func (o *ConvOwnership) run() {
	owners := map[string]string{}
	for op := range o.ops {
		switch op.kind {
		case ownerRecord:
			if op.lane != "" {
				owners[op.convID] = op.lane
			}
		case ownerRelease:
			delete(owners, op.convID)
		case ownerCheck:
			owner, owned := owners[op.convID]
			if owned && owner != op.lane {
				op.errOut <- fmt.Errorf(
					"conversation %s is owned by lane %q; delete requested by lane %q — "+
						"cross-lane deletes tear down a live test's worker and are forbidden",
					op.convID, owner, op.lane)
			} else {
				op.errOut <- nil
			}
		case ownerDump:
			out := make(map[string]string, len(owners))
			for k, v := range owners {
				out[k] = v
			}
			op.mapOut <- out
		case ownerStop:
			return
		}
	}
}

// Record registers lane as the owner of convID. Empty lane is a no-op so
// untagged (production-path) creates never poison the ledger.
func (o *ConvOwnership) Record(convID, lane string) {
	o.ops <- ownerOp{kind: ownerRecord, convID: convID, lane: lane}
}

// Release removes ownership — call after a successful delete.
func (o *ConvOwnership) Release(convID string) {
	o.ops <- ownerOp{kind: ownerRelease, convID: convID}
}

// CheckDelete returns nil if lane may delete convID: the conversation is
// unowned, or lane is its owner. Returns a descriptive error otherwise.
func (o *ConvOwnership) CheckDelete(convID, lane string) error {
	reply := make(chan error, 1)
	o.ops <- ownerOp{kind: ownerCheck, convID: convID, lane: lane, errOut: reply}
	return <-reply
}

// Dump returns a copy of the current ownership map (convID → lane). A
// non-empty dump at suite end means those conversations leaked.
func (o *ConvOwnership) Dump() map[string]string {
	reply := make(chan map[string]string, 1)
	o.ops <- ownerOp{kind: ownerDump, mapOut: reply}
	return <-reply
}

// Stop terminates the actor goroutine.
func (o *ConvOwnership) Stop() {
	o.ops <- ownerOp{kind: ownerStop}
}
