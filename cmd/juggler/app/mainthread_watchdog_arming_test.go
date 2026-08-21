//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// TestWatchdogArmedOnlyAlongsideANativeEventLoop is the structural guard on the
// main-thread watchdog's one precondition.
//
// The watchdog decides the main thread is wedged when a block it dispatches to
// the macOS main queue stops running (mainthread_watchdog_darwin.m). In a
// process that pumps no native event loop, that block never runs at all — so
// the very first probe reads as a wedge, and a launch that is working perfectly
// gets re-exec'd every twelve seconds until the crash-loop guard gives up. That
// is not hypothetical: a Node-hosted server (JUGGLER_ENGINE_HOST=node) runs its
// engine in a child process and creates no application at all.
//
// The watchdog is therefore armed only where a native application is created,
// and only after it is created — the node host returns from
// runHeadlessServerApp before that point, so the arming line is unreachable for
// it by construction rather than by a condition someone has to remember.
func TestWatchdogArmedOnlyAlongsideANativeEventLoop(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob package sources: %v", err)
	}
	fset := token.NewFileSet()
	armings := 0

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
			if !ok {
				continue
			}
			armPos := callPos(fn, isIdentCall("startMainThreadWatchdog"))
			if !armPos.IsValid() {
				continue
			}
			armings++
			newPos := callPos(fn, isSelectorCall("application", "New"))
			if !newPos.IsValid() {
				t.Errorf("%s: %s arms the main-thread watchdog but creates no native application. "+
					"The watchdog probes by dispatching to the main queue, so with no event loop "+
					"draining it every probe reads as a wedge and the process re-execs itself in a "+
					"loop. Arm it where application.New is called.",
					fset.Position(armPos), fn.Name.Name)
				continue
			}
			if armPos < newPos {
				t.Errorf("%s: %s arms the main-thread watchdog before application.New (%s). "+
					"Hosts that need no native application return before that point, so arming "+
					"above it puts them back in the crash loop. Keep the arming below it.",
					fset.Position(armPos), fn.Name.Name, fset.Position(newPos))
			}
		}
	}

	if armings == 0 {
		t.Fatal("nothing arms the main-thread watchdog — the WebKit main-thread wedge across " +
			"sleep/wake now hangs the server forever with nothing to recover it")
	}
}

// callPos returns the position of the first call in fn (including calls inside
// nested function literals) that match reports on, or token.NoPos.
func callPos(fn *ast.FuncDecl, match func(*ast.CallExpr) bool) token.Pos {
	pos := token.NoPos
	ast.Inspect(fn, func(n ast.Node) bool {
		if pos.IsValid() {
			return false
		}
		if call, ok := n.(*ast.CallExpr); ok && match(call) {
			pos = call.Pos()
			return false
		}
		return true
	})
	return pos
}

// isIdentCall matches a call to a plain package-level function, e.g. foo().
func isIdentCall(name string) func(*ast.CallExpr) bool {
	return func(call *ast.CallExpr) bool {
		id, ok := call.Fun.(*ast.Ident)
		return ok && id.Name == name
	}
}

// isSelectorCall matches a call through a selector, e.g. pkg.Foo().
func isSelectorCall(x, sel string) func(*ast.CallExpr) bool {
	return func(call *ast.CallExpr) bool {
		s, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || s.Sel.Name != sel {
			return false
		}
		id, ok := s.X.(*ast.Ident)
		return ok && id.Name == x
	}
}
