//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// writeTestPNG encodes a tiny w×h PNG to path.
func writeTestPNG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write png: %v", err)
	}
}

// TestLoadFileDetectsImage: a supported image within the size cap returns an
// isImage marker (mime, no text content, no warning) so the read tool can
// snapshot it for a multimodal model rather than reporting a binary file.
func TestLoadFileDetectsImage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pic.png")
	writeTestPNG(t, path, 3, 2)

	ops := NewFileOperations(NewPathScope(dir, nil))
	res, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	if m["isImage"] != true {
		t.Fatalf("expected isImage=true, got %#v", m)
	}
	if m["mime"] != "image/png" {
		t.Errorf("expected mime image/png, got %v", m["mime"])
	}
	if m["warning"] != nil {
		t.Errorf("image result must not carry a warning, got %v", m["warning"])
	}
	if m["exists"] != true {
		t.Errorf("expected exists=true, got %v", m["exists"])
	}
	// The bytes travel back as base64 so the read tool can upload them.
	b64, _ := m["imageBase64"].(string)
	if b64 == "" {
		t.Fatalf("expected non-empty imageBase64, got %#v", m)
	}
	if _, err := base64.StdEncoding.DecodeString(b64); err != nil {
		t.Errorf("imageBase64 is not valid base64: %v", err)
	}
}

// TestLoadFileOversizedImageWarns: an image larger than the inline cap falls
// back to the binary-file warning path (no isImage), so it is never snapshotted.
func TestLoadFileOversizedImageWarns(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.png")
	// Above the image cap but below MaxFileSize so ValidateFileSize still passes.
	if err := os.WriteFile(path, make([]byte, MaxImageReadBytes+1), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	ops := NewFileOperations(NewPathScope(dir, nil))
	res, err := ops.Execute(context.Background(), "loadFile", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	if m["isImage"] == true {
		t.Errorf("oversized image must not be inlined: %#v", m)
	}
	if m["warning"] == nil {
		t.Errorf("oversized image must carry a warning")
	}
}

// TestImageMimeForPath maps supported extensions and rejects others.
func TestImageMimeForPath(t *testing.T) {
	cases := map[string]string{
		"a.png":       "image/png",
		"b.JPG":       "image/jpeg",
		"c.jpeg":      "image/jpeg",
		"d.gif":       "image/gif",
		"e.webp":      "image/webp",
		"f.txt":       "",
		"g":           "",
		"dir/h.PNG":   "image/png",
		"weird.png.x": "",
	}
	for path, want := range cases {
		if got := ImageMimeForPath(path); got != want {
			t.Errorf("ImageMimeForPath(%q) = %q, want %q", path, got, want)
		}
	}
}
