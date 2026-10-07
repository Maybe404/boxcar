package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The connections name the program that made them by its path; the page
// shows the icon of the app it belongs to, kept in memory and as a small
// PNG in the data directory. Each platform says which app a path is
// (iconKey), when it last changed (iconStamp), and draws its icon as a
// PNG about 64 pixels wide (drawIcon): icons_darwin.go, icons_windows.go.

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
	bundle := iconKey(path)
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

// load reads the icon of an app from the cache on disk, or draws it and
// keeps it there.
func (c *iconCache) load(app string) string {
	// An app that is gone has no icon, rather than a generic one.
	changed, ok := iconStamp(app)
	if !ok {
		return ""
	}
	sum := sha256.Sum256([]byte(app))
	cached := filepath.Join(c.dir, hex.EncodeToString(sum[:8])+".png")
	// Made again once the app is updated.
	if info, err := os.Stat(cached); err == nil && !changed.After(info.ModTime()) {
		if data, err := os.ReadFile(cached); err == nil {
			return dataURL(data)
		}
	}
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return ""
	}
	png := drawIcon(app, cached+".tmp")
	if png == nil || writeAtomic(c.dir, cached, png) != nil {
		return ""
	}
	return dataURL(png)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dataURL(png []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}
