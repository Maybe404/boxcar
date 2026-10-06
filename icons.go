package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The connections name the program that made them by its path; the page
// shows the icon of the app it belongs to. The icon is read from the
// app's bundle with the system's own plutil and sips, which only read it,
// and kept: in memory, and as a small PNG in the data directory.

type iconCache struct {
	dir   string
	mu    sync.Mutex
	icons map[string]cachedIcon // by bundle
	// loading makes one icon at a time: the files it writes are named by
	// the bundle, and AppKit is asked one call at a time anyway.
	loading sync.Mutex
}

// cachedIcon is a data URL, or "" for none, which is asked again later:
// sips may have timed out.
type cachedIcon struct {
	url string
	at  time.Time
}

const iconRetry = 10 * time.Minute

func newIconCache(dir string) *iconCache {
	return &iconCache{dir: dir, icons: map[string]cachedIcon{}}
}

// bundleOf returns the outermost app bundle a path is in, as a helper
// inside an app shows the app's icon; empty for a program on its own.
func bundleOf(path string) string {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if strings.HasSuffix(p, ".app") {
			return strings.Join(parts[:i+1], "/")
		}
	}
	return ""
}

// icon returns the icon of the app a program's path is in, as a data URL
// of a PNG, or "" when it has none.
func (c *iconCache) icon(path string) string {
	bundle := bundleOf(path)
	if bundle == "" {
		return ""
	}
	c.mu.Lock()
	cached, ok := c.icons[bundle]
	c.mu.Unlock()
	if ok && (cached.url != "" || time.Since(cached.at) < iconRetry) {
		return cached.url
	}
	c.loading.Lock()
	url := c.load(bundle)
	c.loading.Unlock()
	c.mu.Lock()
	c.icons[bundle] = cachedIcon{url: url, at: time.Now()}
	c.mu.Unlock()
	return url
}

func (c *iconCache) load(bundle string) string {
	// An app that is gone has no icon: Finder would give a generic one.
	plist, err := os.Stat(filepath.Join(bundle, "Contents", "Info.plist"))
	if err != nil {
		return ""
	}
	sum := sha256.Sum256([]byte(bundle))
	cached := filepath.Join(c.dir, hex.EncodeToString(sum[:8])+".png")
	// Made again once the app is updated, which rewrites its Info.plist.
	if info, err := os.Stat(cached); err == nil && !plist.ModTime().After(info.ModTime()) {
		if data, err := os.ReadFile(cached); err == nil {
			return dataURL(data)
		}
	}
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return ""
	}
	icns := iconFile(bundle)
	if icns == "" {
		// The icon Finder shows, drawn at its size by AppKit.
		png := workspaceIcon(bundle)
		if png == nil || writeAtomic(c.dir, cached, png) != nil {
			return ""
		}
		return dataURL(png)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tmp := cached + ".tmp.png"
	if err := exec.CommandContext(ctx, "/usr/bin/sips", "-s", "format", "png", "-Z", "64", icns, "--out", tmp).Run(); err != nil {
		os.Remove(tmp)
		return ""
	}
	if err := os.Rename(tmp, cached); err != nil {
		return ""
	}
	data, err := os.ReadFile(cached)
	if err != nil {
		return ""
	}
	return dataURL(data)
}

// iconFile finds the .icns of a bundle, as its Info.plist names it.
func iconFile(bundle string) string {
	resources := filepath.Join(bundle, "Contents", "Resources")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/plutil", "-extract", "CFBundleIconFile", "raw", "-o", "-", filepath.Join(bundle, "Contents", "Info.plist")).Output()
	if name := strings.TrimSpace(string(out)); err == nil && name != "" {
		if !strings.HasSuffix(name, ".icns") {
			name += ".icns"
		}
		if path := filepath.Join(resources, filepath.Base(name)); fileExists(path) {
			return path
		}
	}
	// Apps whose plist names an asset catalog often still ship this.
	if path := filepath.Join(resources, "AppIcon.icns"); fileExists(path) {
		return path
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dataURL(png []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}
