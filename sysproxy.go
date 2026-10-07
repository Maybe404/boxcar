package main

import (
	stdjson "encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
)

// Each platform has its own system proxy (sysproxy_darwin.go,
// sysproxy_windows.go), behind the same four functions:
//
//	takeSnapshot() (*proxySnapshot, error)  what the proxy is now
//	applyProxy(snap, host, port, socks)    points it at the core
//	restoreProxy(snap) error               puts the snapshot back
//	currentProxy() string                  describes it, for the page
//
// and proxySnapshot, which is kept as JSON while the proxy is set, has
// valid(), false for a snapshot that could not be read back.

// systemProxy points the system proxy at sing-box, and restores what it
// was. sing-box's own system proxy turns
// the proxy off when it stops, which would drop another app's; this one
// puts the previous settings back.
type systemProxy struct {
	mu   sync.Mutex
	path string // where the snapshot is kept while set, to restore after a crash
	snap *proxySnapshot
	// address is where the proxy points while set.
	address string
}

func newSystemProxy(path string) *systemProxy {
	return &systemProxy{path: path}
}

// recover restores the proxy that a previous run of the app left set,
// when it did not get to, and reports whether there was one.
func (p *systemProxy) recover() (bool, error) {
	data, err := os.ReadFile(p.path)
	if err != nil {
		return false, nil
	}
	var snap proxySnapshot
	if stdjson.Unmarshal(data, &snap) != nil || !snap.valid() {
		os.Remove(p.path)
		return false, nil
	}
	p.mu.Lock()
	p.snap = &snap
	p.mu.Unlock()
	return true, p.disable()
}

// active reports whether the app has set the system proxy, and where.
func (p *systemProxy) active() (bool, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snap != nil, p.address
}

// enable points the system proxy at host:port, HTTP and HTTPS, and SOCKS
// when the inbound speaks it.
func (p *systemProxy) enable(host string, port int, socks bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.snap == nil {
		snap, err := takeSnapshot()
		if err != nil {
			return err
		}
		// Kept on disk first, to put back after a crash.
		data, _ := stdjson.MarshalIndent(snap, "", "  ")
		if err := os.WriteFile(p.path, data, 0o600); err != nil {
			return err
		}
		p.snap = snap
	}
	err := applyProxy(p.snap, host, port, socks)
	p.address = fmt.Sprintf("%s:%d", host, port)
	return err
}

// disable puts back the system proxy as it was.
func (p *systemProxy) disable() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.snap == nil {
		return nil
	}
	err := restoreProxy(p.snap)
	if err == nil {
		os.Remove(p.path)
		p.snap, p.address = nil, ""
	}
	return err
}

// proxyFor reads the proxy setting of Windows, kept here to be tested
// anywhere: ProxyServer: "host:port" for every scheme, or
// "http=host:port;https=host:port;socks=host:port".
func proxyFor(server, scheme string) *url.URL {
	if !strings.Contains(server, "=") {
		return &url.URL{Scheme: "http", Host: server}
	}
	byScheme := map[string]string{}
	for part := range strings.SplitSeq(server, ";") {
		if k, v, ok := strings.Cut(strings.TrimSpace(part), "="); ok {
			byScheme[strings.ToLower(k)] = v
		}
	}
	if host := byScheme[scheme]; host != "" {
		return &url.URL{Scheme: "http", Host: host}
	}
	if host := byScheme["socks"]; host != "" {
		return &url.URL{Scheme: "socks5", Host: host}
	}
	return nil
}
