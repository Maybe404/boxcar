package main

import (
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/log"
)

// logEntry is a line the core logged.
type logEntry struct {
	Time    time.Time
	Level   log.Level
	Message string
}

// logBuffer keeps the last lines the core logged. It is the core's
// platform writer, which receives every line.
type logBuffer struct {
	mu       sync.Mutex
	entries  []logEntry
	limit    int
	level    log.Level // the configuration's level; sing-box writes every level here
	version  int       // counts changes, for the page to notice them
	onAppend func()
	// activity takes the lines that tell of the core's own network
	// work, at every level.
	activity *activityLog
}

var _ log.PlatformWriter = (*logBuffer)(nil)

func newLogBuffer(limit int) *logBuffer {
	return &logBuffer{limit: limit, level: log.LevelInfo, activity: &activityLog{}}
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
	activity := b.activity.add(level, message)
	b.mu.Lock()
	drop := level > b.level
	onAppend := b.onAppend
	b.mu.Unlock()
	if !drop {
		b.add(level, message)
	} else if activity && onAppend != nil {
		onAppend()
	}
}

// add appends a line, of the core or of the app.
func (b *logBuffer) add(level log.Level, message string) {
	message = clean(message)
	b.mu.Lock()
	b.entries = append(b.entries, logEntry{Time: time.Now(), Level: level, Message: message})
	if len(b.entries) > b.limit {
		// Drop a tenth at a time, rather than one line for every line.
		b.entries = append(b.entries[:0:0], b.entries[len(b.entries)-b.limit*9/10:]...)
	}
	b.version++
	onAppend := b.onAppend
	b.mu.Unlock()
	if onAppend != nil {
		onAppend()
	}
}

// snapshot returns the lines at or above a level, and the version.
func (b *logBuffer) snapshot(level log.Level, query string) ([]logEntry, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	query = strings.ToLower(query)
	out := make([]logEntry, 0, len(b.entries))
	for _, e := range b.entries {
		if e.Level > level {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(e.Message), query) {
			continue
		}
		out = append(out, e)
	}
	return out, b.version
}

func (b *logBuffer) Version() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.version
}

func (b *logBuffer) clear() {
	b.mu.Lock()
	b.entries = nil
	b.version++
	b.mu.Unlock()
}

// text returns the lines as text, to copy.
func (b *logBuffer) text(entries []logEntry) string {
	var sb strings.Builder
	for _, e := range entries {
		sb.WriteString(e.Time.Format("15:04:05"))
		sb.WriteString(" ")
		sb.WriteString(strings.ToUpper(log.FormatLevel(e.Level)))
		sb.WriteString(" ")
		sb.WriteString(e.Message)
		sb.WriteString("\n")
	}
	return sb.String()
}
