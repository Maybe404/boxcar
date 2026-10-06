package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"
)

// Every profile keeps its source beside it: the file as imported, the
// subscription as last downloaded, or the sample it was created from.
// What the user changed is the profile against its source, so nothing
// else is stored for it, and an update of a subscription can keep it.

// The kinds of source of a profile.
const (
	originImport       = "import"
	originNew          = "new"
	originSubscription = "subscription"
	originLegacy       = "legacy"
	originSample       = "sample"
	// originUnknown is a profile from before sources were kept: its
	// source is the profile as it was found.
	originUnknown = ""
)

// Origin is where a profile comes from, and when it changed.
type Origin struct {
	// Kind is import, new, subscription, legacy, sample, or empty when
	// unknown.
	Kind string `json:"kind"`
	// From is the file it was imported from.
	From string `json:"from,omitempty"`
	// SourcedAt is when the source was imported, downloaded or created.
	SourcedAt time.Time `json:"sourcedAt"`
	// SavedAt is when the profile was last saved from the app.
	SavedAt time.Time `json:"savedAt,omitzero"`
}

func (s *store) sourcesDir() string { return filepath.Join(s.profilesDir(), ".source") }

func (s *store) sourcePath(name string) string {
	return filepath.Join(s.sourcesDir(), name+".json")
}

// source returns the source of a profile.
func (s *store) source(name string) ([]byte, error) {
	return os.ReadFile(s.sourcePath(name))
}

// setSource keeps content as the source of a profile, from where it came.
func (s *store) setSource(name string, content []byte, kind, from string) error {
	if err := writeAtomic(s.sourcesDir(), s.sourcePath(name), content); err != nil {
		return err
	}
	s.update(func(set *settings) {
		if set.Origins == nil {
			set.Origins = map[string]*Origin{}
		}
		o := &Origin{Kind: kind, From: from, SourcedAt: time.Now().Truncate(time.Second)}
		if old := set.Origins[name]; old != nil && kind == old.Kind {
			// Updated in place, as a subscription: the last save stays.
			o.SavedAt = old.SavedAt
		}
		set.Origins[name] = o
	})
	return nil
}

// markSaved notes that the profile was saved from the app.
func (s *store) markSaved(name string) {
	s.update(func(set *settings) {
		if o := set.Origins[name]; o != nil {
			o.SavedAt = time.Now().Truncate(time.Second)
		}
	})
}

// ensureSources gives the profiles from before sources were kept the
// source they have now.
func (s *store) ensureSources() {
	list, _ := s.profiles()
	for _, p := range list {
		if _, err := os.Stat(s.sourcePath(p.Name)); err == nil {
			continue
		}
		content, err := os.ReadFile(p.Path)
		if err != nil {
			continue
		}
		kind := originUnknown
		if s.settings().Remote[p.Name] != nil {
			kind = originSubscription
		}
		if writeAtomic(s.sourcesDir(), s.sourcePath(p.Name), content) != nil {
			continue
		}
		s.update(func(set *settings) {
			if set.Origins == nil {
				set.Origins = map[string]*Origin{}
			}
			if set.Origins[p.Name] == nil {
				set.Origins[p.Name] = &Origin{Kind: kind, SourcedAt: p.ModTime.Truncate(time.Second)}
			}
		})
	}
}

// renameSource follows a profile renamed. Without its source file, the
// origin goes too, and the source is made again from the profile.
func (s *store) renameSource(from, to string) {
	s.forgetEdited(from)
	if err := os.Rename(s.sourcePath(from), s.sourcePath(to)); err != nil {
		s.update(func(set *settings) { delete(set.Origins, from) })
		s.ensureSources()
		return
	}
	s.update(func(set *settings) {
		if o, ok := set.Origins[from]; ok {
			delete(set.Origins, from)
			set.Origins[to] = o
		}
	})
}

// forgetEdited drops what was known of a profile renamed or removed.
func (s *store) forgetEdited(name string) {
	editedMu.Lock()
	delete(editedCache, s.path(name))
	editedMu.Unlock()
}

// removeSource forgets the source of a profile removed.
func (s *store) removeSource(name string) {
	s.forgetEdited(name)
	os.Remove(s.sourcePath(name))
	s.update(func(set *settings) { delete(set.Origins, name) })
}

// edited reports whether a profile differs from its source in what it
// says: formatting and comments aside.
func (s *store) edited(name string) bool {
	// Read again only when either file changed: a subscription may be
	// megabytes, and the list asks for every profile.
	ci, err1 := os.Stat(s.path(name))
	si, err2 := os.Stat(s.sourcePath(name))
	if err1 != nil || err2 != nil {
		return false
	}
	key := editedKey{ci.ModTime(), ci.Size(), si.ModTime(), si.Size()}
	editedMu.Lock()
	cached, ok := editedCache[s.path(name)]
	editedMu.Unlock()
	if ok && cached.key == key {
		return cached.edited
	}
	current, err := s.read(name)
	if err != nil {
		return false
	}
	source, err := s.source(name)
	if err != nil {
		return false
	}
	edited := !sameConfig(current, source)
	editedMu.Lock()
	editedCache[s.path(name)] = editedEntry{key, edited}
	editedMu.Unlock()
	return edited
}

type editedKey struct {
	currentTime time.Time
	currentSize int64
	sourceTime  time.Time
	sourceSize  int64
}

type editedEntry struct {
	key    editedKey
	edited bool
}

var (
	editedMu    sync.Mutex
	editedCache = map[string]editedEntry{}
)

// sameConfig reports whether two configurations say the same, read as the
// core reads them, comments allowed.
func sameConfig(a, b []byte) bool {
	if bytes.Equal(a, b) {
		return true
	}
	ra, rb := rawJSON(a), rawJSON(b)
	if ra == nil || rb == nil {
		return false
	}
	return reflect.DeepEqual(ra, rb)
}

// writeAtomic writes a file in dir through a temporary file renamed over
// it, so that it is never half written.
func writeAtomic(dir, path string, content []byte) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	_, err = f.Write(content)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(f.Name(), 0o644)
	}
	if err != nil {
		os.Remove(f.Name())
		return err
	}
	return os.Rename(f.Name(), path)
}

var errNoSource = errors.New("这份配置没有保存来源")
