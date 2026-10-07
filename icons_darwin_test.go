package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestIconFromAnAppBundle(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Demo.app")
	writeFile(t, filepath.Join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIconFile</key><string>Demo</string></dict></plist>`)
	// An icon made with the same tool that reads it.
	img := image.NewRGBA(image.Rect(0, 0, 128, 128))
	for i := range img.Pix {
		img.Pix[i] = 0xff
	}
	img.Set(1, 1, color.RGBA{0x2e, 0x5c, 0xf6, 0xff})
	src := filepath.Join(dir, "icon.png")
	f, _ := os.Create(src)
	png.Encode(f, img)
	f.Close()
	resources := filepath.Join(app, "Contents", "Resources")
	os.MkdirAll(resources, 0o755)
	if err := exec.Command("/usr/bin/sips", "-s", "format", "icns", src, "--out", filepath.Join(resources, "Demo.icns")).Run(); err != nil {
		t.Skip("sips cannot make an icns here:", err)
	}

	c := newIconCache(filepath.Join(dir, "icons"))
	url := c.icon(filepath.Join(app, "Contents", "MacOS", "Demo"))
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("icon %.40q", url)
	}
	if c.icon("/usr/bin/curl") != "" {
		t.Fatal("an icon for a program without an app")
	}
	// From the cache on disk, once forgotten in memory.
	again := newIconCache(filepath.Join(dir, "icons"))
	if again.icon(filepath.Join(app, "Contents", "MacOS", "Demo")) != url {
		t.Fatal("not cached")
	}
}

func TestWorkspaceIcon(t *testing.T) {
	app := "/System/Applications/Calculator.app"
	if _, err := os.Stat(app); err != nil {
		t.Skip("no Calculator here")
	}
	// From goroutines at once, as connections ask for icons: it must
	// neither crash nor draw every size the icon has.
	done := make(chan []byte, 8)
	for range 8 {
		go func() { done <- workspaceIcon(app) }()
	}
	for range 8 {
		data := <-done
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("not a PNG: %v (%d bytes)", err, len(data))
		}
		if w := img.Bounds().Dx(); w < 32 || w > 256 || len(data) > 200<<10 {
			t.Fatalf("%d px, %d bytes", w, len(data))
		}
	}
	// An app that is gone has no icon, rather than a generic one.
	if url := newIconCache(t.TempDir()).icon("/Applications/Gone.app/Contents/MacOS/Gone"); url != "" {
		t.Fatal("an icon for an app that is not there")
	}
}
