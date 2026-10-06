package main

import (
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/log"
)

// ActivityKind is what a network activity of the core itself is.
type ActivityKind string

const (
	ActivityDNS     ActivityKind = "dns"
	ActivityRuleSet ActivityKind = "rule-set"
	ActivityURLTest ActivityKind = "urltest"
	ActivityNTP     ActivityKind = "ntp"
	ActivityRoute   ActivityKind = "route"
)

// Activity is network work of the core that is not a routed connection,
// and so not in the connections: DNS queries, rule-set downloads, URL
// tests, NTP, rejected and hijacked connections. sing-box tells of them
// only in its log, which its platform writer receives at every level.
type Activity struct {
	Time    time.Time    `json:"time"`
	Kind    ActivityKind `json:"kind"`
	Level   string       `json:"level"`
	Tag     string       `json:"tag"`
	Message string       `json:"message"`
}

const activityLimit = 4000

// activityLog keeps the activities, apart from the log the page shows,
// so that a busy log does not push them out.
type activityLog struct {
	mu      sync.Mutex
	entries []Activity
	version int
}

// The parts of a line: "[1234567890 12ms] tag: message".
var (
	idPrefix = regexp.MustCompile(`^\[[^\]]*\] `)
	tagEnd   = regexp.MustCompile(`^([a-z0-9-]+(?:/[a-z0-9-]+)?(?:\[[^\]]*\])?): `)
)

// classify returns what a line of the log tells of, if anything.
func classify(message string) (ActivityKind, string, bool) {
	rest := idPrefix.ReplaceAllString(message, "")
	m := tagEnd.FindStringSubmatch(rest)
	if m == nil {
		return "", "", false
	}
	tag := m[1]
	body := rest[len(m[0]):]
	switch {
	case tag == "dns" || strings.HasPrefix(tag, "dns/"):
		return ActivityDNS, tag, true
	case tag == "ntp":
		return ActivityNTP, tag, true
	case strings.Contains(body, "rule-set"):
		return ActivityRuleSet, tag, true
	case strings.HasPrefix(tag, "outbound/urltest") && (strings.Contains(body, "available") || strings.Contains(body, "unavailable")):
		return ActivityURLTest, tag, true
	case tag == "router" && (strings.Contains(body, "reject") || strings.Contains(body, "hijack") || strings.Contains(body, "connection closed")):
		return ActivityRoute, tag, true
	}
	return "", "", false
}

// add keeps a line that tells of the core's own network work, and
// reports whether it did.
func (a *activityLog) add(level log.Level, message string) bool {
	kind, tag, ok := classify(message)
	if !ok {
		return false
	}
	a.mu.Lock()
	a.entries = append(a.entries, Activity{
		Time:    time.Now().Truncate(time.Millisecond),
		Kind:    kind,
		Level:   log.FormatLevel(level),
		Tag:     tag,
		Message: message,
	})
	if len(a.entries) > activityLimit {
		a.entries = append(a.entries[:0:0], a.entries[len(a.entries)-activityLimit*9/10:]...)
	}
	a.version++
	a.mu.Unlock()
	return true
}

// list returns the activities of a kind ("" for all) that contain query,
// newest last, at most limit.
func (a *activityLog) list(kind ActivityKind, query string, limit int) []Activity {
	a.mu.Lock()
	defer a.mu.Unlock()
	query = strings.ToLower(query)
	out := []Activity{}
	for i := len(a.entries) - 1; i >= 0 && len(out) < limit; i-- {
		e := a.entries[i]
		if kind != "" && e.Kind != kind {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(e.Message), query) {
			continue
		}
		out = append(out, e)
	}
	// Oldest first, as a log reads.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func (a *activityLog) clear() {
	a.mu.Lock()
	a.entries = nil
	a.version++
	a.mu.Unlock()
}
