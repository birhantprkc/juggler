//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The structural guard on the polite stop's one open question: a worker op that
// starts work has to say whether the human asked for it.
//
// A pause is a mark that stands until a human lifts it (polite_stop.go). So an
// op that starts work under one is either HUMAN INTENT — the user asked for this,
// now, so it lifts the marks covering the thread it runs on, exactly as a send
// does — or MACHINE CONTINUATION, the conversation carrying on by itself, which
// is what the pause is a statement about, so the mark stands and the work waits.
//
// Nothing about the code says which, and the wrong answer is not a suppressed
// turn: an op commits to the document FIRST (a fold, a cleared summary, a reset
// tool, a new thread) and only then meets a boundary that rests. /compact under a
// landed pause folded the entire conversation into a thread, consumed the
// one-shot needsStrategyRun the pickup runs on, and rested — leaving the history
// behind a tile with no summary and nothing anywhere able to ask for one.
//
// This test makes the question unskippable. Every op in the dispatch switch that
// starts work must either lift, or be listed below with a reason. Adding an op
// that does neither fails here, naming the op and both ways out.
//
// It cannot tell a human from a machine, and does not try to. It only refuses to
// let the choice go unmade.

// machineContinuationOps are the ops that start work and must NOT lift the mark,
// each with the reason it is not a human asking. An entry here is a claim about
// the op, so it is spelled out rather than left as a name on a list.
var machineContinuationOps = map[string]string{
	"init": "a worker starting up runs whatever the document says is owed; " +
		"nobody pressed anything",
	"yjs-sync": "the browser's document sync. It carries whatever the viewer " +
		"changed, and a pause is answered by the ops that mean it, not by the " +
		"sync that happens to deliver one",
	"inject-thread-message": "delivered background-task output. The task was " +
		"started earlier and reports whenever it reports; a pause is exactly the " +
		"statement that the conversation should not act on its own",
}

// workStartVerbs are the calls that begin an LLM turn: queueing a thread for
// dispatch, re-arming the doc-driven run trigger, and driving the pickup.
var workStartVerbs = []string{"requestLLM", "setThreadNeedsStrategyRun", "checkForNewThreads"}

// politeStopLifters are the calls that lift a mark. handleUnpause's own drop is
// among them, which is why unpause needs no entry in the table above.
var politeStopLifters = []string{"dropPoliteStopsCovering", "dropPoliteStopsUnder", "dropAllPoliteStops"}

// classificationHops is how far from the handler both questions are asked. One
// hop, because that is where an op's own intent is still legible: handleCompact
// drives the pickup itself, and a retry handler's lift is one call down in the
// tail it shares. Beyond that every op reaches everything through the reducer,
// and the answer stops meaning anything.
const classificationHops = 1

func TestEveryWorkStartingOpClassifiesItselfAgainstThePause(t *testing.T) {
	calls, ops := parseWorkerDispatch(t)

	starters := 0
	for _, op := range ops {
		if !reachesCall(calls, op.handler, workStartVerbs, classificationHops) {
			continue
		}
		starters++
		lifts := reachesCall(calls, op.handler, politeStopLifters, classificationHops)
		reason, listed := machineContinuationOps[op.op]

		switch {
		case lifts && listed:
			t.Errorf("op %q (%s) lifts the pause, but machineContinuationOps says it must not: %q. "+
				"Both cannot be true. Drop the entry, or drop the lift.", op.op, op.handler, reason)
		case !lifts && !listed:
			t.Errorf("op %q (%s) starts work but says nothing about the pause standing over it.\n"+
				"  If a human asked for this: call dropPoliteStopsCovering(<the thread it runs on>) "+
				"before starting, as handleSendMessage does — a mark outlives the rest it caused and "+
				"would suppress the very turn just asked for.\n"+
				"  If it is the conversation carrying on by itself: add %q to machineContinuationOps "+
				"with the reason, and make sure what it commits survives the wait — the pickup's "+
				"needsStrategyRun is one-shot, and work rested after that is spent is work nothing "+
				"can start again.\n"+
				"  See the classification in polite_stop.go.", op.op, op.handler, op.op)
		}
	}

	// The detector going quiet must be a failure, not a pass: every assertion
	// above is skipped for an op that looks like it starts no work, so a parse
	// that finds nothing would report a clean sheet for a rule it never read.
	if starters < 6 {
		t.Fatalf("only %d ops look like they start work, out of %d in the dispatch switch — "+
			"the call-graph walk has stopped seeing them, and this test now passes by not looking",
			starters, len(ops))
	}

	// A stale entry is worse than none: it claims an op was thought about, and
	// silences the check for a name that no longer starts work (or no longer
	// exists) while reading as deliberate.
	known := make(map[string]bool, len(ops))
	for _, op := range ops {
		if reachesCall(calls, op.handler, workStartVerbs, classificationHops) {
			known[op.op] = true
		}
	}
	stale := []string{}
	for op := range machineContinuationOps {
		if !known[op] {
			stale = append(stale, op)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("machineContinuationOps names %v, which no longer start work (or no longer exist). "+
			"Delete the entries: an exemption nobody needs still reads as a decision someone made.", stale)
	}
}

// workerOp pairs a dispatch-switch case with the handler it calls.
type workerOp struct {
	op      string
	handler string
}

// parseWorkerDispatch reads the package's own sources and returns the call graph
// (function name → the names it calls, including inside closures) together with
// every op in the run loop's dispatch switch.
//
// Keyed by name rather than by receiver: two methods sharing a name would be
// conflated, which can only make this test more willing to believe an op lifts.
// The vacuity guards above exist for that reason.
func parseWorkerDispatch(t *testing.T) (map[string]map[string]bool, []workerOp) {
	t.Helper()

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob package sources: %v", err)
	}
	fset := token.NewFileSet()
	calls := map[string]map[string]bool{}
	var ops []workerOp

	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}

		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			named := calls[fn.Name.Name]
			if named == nil {
				named = map[string]bool{}
				calls[fn.Name.Name] = named
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					if name := calleeName(call); name != "" {
						named[name] = true
					}
				}
				return true
			})
		}

		ast.Inspect(parsed, func(n ast.Node) bool {
			sw, ok := n.(*ast.SwitchStmt)
			if !ok || !isSelector(sw.Tag, "msg", "Type") {
				return true
			}
			for _, stmt := range sw.Body.List {
				clause, ok := stmt.(*ast.CaseClause)
				if !ok {
					continue
				}
				for _, expr := range clause.List {
					lit, ok := expr.(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING {
						continue
					}
					name := strings.Trim(lit.Value, `"`)
					for _, s := range clause.Body {
						if h := firstHandlerCall(s); h != "" {
							ops = append(ops, workerOp{op: name, handler: h})
							break
						}
					}
				}
			}
			return true
		})
	}

	if len(ops) == 0 {
		t.Fatal("found no ops in the run loop's dispatch switch — this test reads that switch to " +
			"know what to check, so it is now checking nothing")
	}
	return calls, ops
}

// firstHandlerCall returns the name of the first handleXxx call in a statement.
func firstHandlerCall(stmt ast.Stmt) string {
	found := ""
	ast.Inspect(stmt, func(n ast.Node) bool {
		if found != "" {
			return false
		}
		if call, ok := n.(*ast.CallExpr); ok {
			if name := calleeName(call); strings.HasPrefix(name, "handle") {
				found = name
				return false
			}
		}
		return true
	})
	return found
}

// calleeName returns the called function's own name for `foo()` and `x.foo()`.
func calleeName(call *ast.CallExpr) string {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		return fun.Name
	case *ast.SelectorExpr:
		return fun.Sel.Name
	}
	return ""
}

// isSelector reports whether expr is exactly `x.sel`.
func isSelector(expr ast.Expr, x, sel string) bool {
	s, ok := expr.(*ast.SelectorExpr)
	if !ok || s.Sel.Name != sel {
		return false
	}
	id, ok := s.X.(*ast.Ident)
	return ok && id.Name == x
}

// reachesCall reports whether start, or anything it calls within maxHops, calls
// one of the named functions.
func reachesCall(calls map[string]map[string]bool, start string, targets []string, maxHops int) bool {
	wanted := make(map[string]bool, len(targets))
	for _, name := range targets {
		wanted[name] = true
	}
	seen := map[string]bool{start: true}
	frontier := []string{start}
	for hop := 0; hop <= maxHops && len(frontier) > 0; hop++ {
		var next []string
		for _, fn := range frontier {
			for callee := range calls[fn] {
				if wanted[callee] {
					return true
				}
				if !seen[callee] {
					seen[callee] = true
					next = append(next, callee)
				}
			}
		}
		frontier = next
	}
	return false
}
