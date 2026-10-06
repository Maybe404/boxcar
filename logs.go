package main

import (
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/log"
)

// The sources of a log line: the core, or the app around it.
const (
	sourceCore = "core"
	sourceApp  = "app"
)

// logEntry is a line the core or the app logged.
type logEntry struct {
	Time    time.Time
	Level   log.Level
	Source  string
	Message string
}

// logBuffer keeps the last lines the core and the app logged. It is the
// core's platform writer, which receives every line.
type logBuffer struct {
	mu      sync.Mutex
	entries []logEntry
	limit   int
	// app are the app's own lines, kept apart so that a busy core log
	// does not push them out.
	app      []logEntry
	level    log.Level // the configuration's level; sing-box writes every level here
	version  int       // counts changes, for the page to notice them
	onAppend func()
	// activity takes the lines that tell of the core's own network
	// work, at every level.
	activity *activityLog
	// dns puts the core's DNS queries together from their lines, and
	// conns keeps each connection's lines by ID, at every level.
	dns   *dnsLog
	conns *connLogs
}

// appLimit is how many of the app's own lines are kept.
const appLimit = 1000

var _ log.PlatformWriter = (*logBuffer)(nil)

func newLogBuffer(limit int) *logBuffer {
	return &logBuffer{limit: limit, level: log.LevelInfo, activity: &activityLog{}, dns: newDNSLog(), conns: newConnLogs()}
}

var (
	ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	// prefix is the level and the seconds since start, which the page
	// shows apart: "INFO[0012] ".
	prefix = regexp.MustCompile(`^[A-Z]+\[\d+\] `)
)

// clean removes the colors and the level prefix of a line.
func clean(message string) string {
	return prefix.ReplaceAllString(strings.TrimRight(ansi.ReplaceAllString(message, ""), "\n"), "")
}

// setLevel drops the lines more detailed than the configuration asks for.
func (b *logBuffer) setLevel(level log.Level) {
	b.mu.Lock()
	b.level = level
	b.mu.Unlock()
}

// WriteMessage takes a line of the core, which sends every level.
func (b *logBuffer) WriteMessage(level log.Level, message string) {
	message = clean(message)
	now := time.Now()
	activity := b.activity.add(level, message)
	id, tag, body := splitLine(message)
	if id != 0 {
		b.conns.add(id, logEntry{Time: now, Level: level, Source: sourceCore, Message: message})
	}
	b.dns.add(id, tag, body, now)
	b.mu.Lock()
	drop := level > b.level
	onAppend := b.onAppend
	b.mu.Unlock()
	if !drop {
		b.push(sourceCore, level, message)
	} else if activity && onAppend != nil {
		onAppend()
	}
}

// add appends a line of the app: what it did around the core, as setting
// the system proxy or updating a subscription. The configuration's level
// does not apply to it.
func (b *logBuffer) add(level log.Level, message string) {
	b.push(sourceApp, level, message)
}

func (b *logBuffer) push(source string, level log.Level, message string) {
	message = clean(message)
	e := logEntry{Time: time.Now(), Level: level, Source: source, Message: message}
	b.mu.Lock()
	if source == sourceApp {
		b.app = trimmed(append(b.app, e), appLimit)
	} else {
		b.entries = trimmed(append(b.entries, e), b.limit)
	}
	b.version++
	onAppend := b.onAppend
	b.mu.Unlock()
	if onAppend != nil {
		onAppend()
	}
}

// snapshot returns the lines at or above a level, of a source or of
// both (""), that contain query, and the version.
func (b *logBuffer) snapshot(level log.Level, source, query string) ([]logEntry, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	query = strings.ToLower(query)
	keep := func(e logEntry) bool {
		return e.Level <= level && (query == "" || strings.Contains(strings.ToLower(e.Message), query))
	}
	// The core's lines and the app's, merged in time.
	var core, app []logEntry
	if source != sourceApp {
		core = b.entries
	}
	if source != sourceCore {
		app = b.app
	}
	out := make([]logEntry, 0, len(core)+len(app))
	i, j := 0, 0
	for i < len(core) || j < len(app) {
		var e logEntry
		if j >= len(app) || (i < len(core) && !core[i].Time.After(app[j].Time)) {
			e, i = core[i], i+1
		} else {
			e, j = app[j], j+1
		}
		if keep(e) {
			out = append(out, e)
		}
	}
	return out, b.version
}

// trimmed drops the oldest tenth of a list over its limit, rather than one
// line for every line.
func trimmed(list []logEntry, limit int) []logEntry {
	if len(list) <= limit {
		return list
	}
	return append(list[:0:0], list[len(list)-limit*9/10:]...)
}

func (b *logBuffer) Version() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.version
}

func (b *logBuffer) clear() {
	b.mu.Lock()
	b.entries, b.app = nil, nil
	b.version++
	b.mu.Unlock()
}
