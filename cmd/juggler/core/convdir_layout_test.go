//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The structural guard on where a conversation's on-disk layout is written
// down: convdir.go, and nothing else.
//
// The layout is two encodings — what the folder is called (`<name>--<id>`,
// BuildDirName/ParseDirName) and what lives inside it (doc.yjs, txns/,
// assets/) — and both are the store's business. A package that spells either
// one is a package that would have to be found and edited to change it, and
// the worker was one: it joined "doc.yjs" itself, and read a tab's title by
// decoding the folder name it happened to be handed.
//
// A duplicated path literal fails nothing while it agrees. This test is what
// makes the layout one decision rather than a convention several packages
// currently keep.

// layoutNames maps each entry of a conversation folder to the accessor that
// returns it, so a violation names its own fix.
var layoutNames = map[string]string{
	"doc.yjs": "ConvDocPath",
	"txns":    "ConvTxnsDir",
	"assets":  "ConvAssetsDir",
}

// dirNameCodec is the folder-name encoding. Reading a conversation's name out
// of its folder is the store answering a question about its own filesystem;
// everyone else is handed the name.
var dirNameCodec = map[string]bool{
	"BuildDirName": true,
	"ParseDirName": true,
}

// layoutOwner is the one file allowed to spell the names, relative to the
// package directory this test runs in.
const layoutOwner = "../core/convdir.go"

func TestConversationFolderLayoutIsOwnedByCore(t *testing.T) {
	fset := token.NewFileSet()
	var violations []string
	files, accessorUses := 0, 0

	// "../" is cmd/juggler: every package of the server, the worker, the ops
	// and the desktop app, which is the whole population that could store
	// something for a conversation.
	err := filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel := filepath.ToSlash(path)
		parsed, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return fmt.Errorf("parse %s: %w", rel, err)
		}
		files++

		inCore := strings.HasPrefix(rel, "../core/")
		isOwner := rel == layoutOwner
		at := func(n ast.Node) string { return fmt.Sprintf("%s:%d", rel, fset.Position(n.Pos()).Line) }

		ast.Inspect(parsed, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.BasicLit:
				if node.Kind != token.STRING || isOwner {
					return true
				}
				value, err := strconv.Unquote(node.Value)
				if err != nil {
					return true
				}
				if accessor, ok := layoutNames[value]; ok {
					violations = append(violations, fmt.Sprintf(
						"%s spells %q — join it with core.%s(convDir) instead", at(node), value, accessor))
				}
			case *ast.Ident:
				if dirNameCodec[node.Name] && !inCore {
					violations = append(violations, fmt.Sprintf(
						"%s calls %s — the folder name is the store's encoding; be handed the name instead", at(node), node.Name))
				}
				if !inCore {
					for _, accessor := range layoutNames {
						if node.Name == accessor {
							accessorUses++
						}
					}
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk cmd/juggler: %v", err)
	}

	sort.Strings(violations)
	for _, v := range violations {
		t.Errorf("%s", v)
	}

	// Both guards below exist because every assertion above is a scan finding
	// nothing: a walk that stopped reading the tree, or an AST shape that
	// stopped matching, would report a clean sheet for a rule it never read.
	if files < 250 {
		t.Fatalf("only %d production files parsed under cmd/juggler — the walk has stopped seeing the tree, "+
			"and this test now passes by not looking", files)
	}
	if accessorUses < 3 {
		t.Fatalf("the layout accessors are called %d times outside core — the packages that store things for a "+
			"conversation are meant to go through them, so either they have stopped, or this scan can no longer "+
			"see the calls it is checking for", accessorUses)
	}
}
