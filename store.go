package main

import (
	stdjson "encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// profile is a configuration file of sing-box the app keeps.
type profile struct {
	Name    string
	Path    string
	Size    int64
	ModTime time.Time
}

// settings are the app's preferences.
type settings struct {
	// Active is the name of the profile the Start button runs.
	Active string `json:"active"`
	// Theme is system, light or dark.
	Theme string `json:"theme,omitempty"`
	// SystemProxy points the system proxy at sing-box while it runs.
	SystemProxy bool `json:"systemProxy,omitempty"`
	// Remote are the profiles that are subscriptions, by name.
	Remote map[string]*Remote `json:"remote,omitempty"`
}

// store keeps the profiles and the settings in a directory:
//
//	profiles/<name>.json
//	settings.json
//	work/              the working directory of the core (cache files)
type store struct {
	mu  sync.Mutex
	dir string
	set settings
	// files serializes making and renaming profiles.
	files sync.Mutex
}

func openStore(dir string) (*store, error) {
	s := &store{dir: dir}
	for _, d := range []string{s.profilesDir(), s.workDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, "settings.json")); err == nil {
		stdjson.Unmarshal(data, &s.set)
	}
	if list, _ := s.profiles(); len(list) == 0 {
		// A first profile that only listens on the loopback address and
		// leaves the system's network alone.
		if err := s.write(sampleName, []byte(sampleProfile)); err != nil {
			return nil, err
		}
		s.set.Active = sampleName
		s.saveLocked()
	}
	return s, nil
}

func (s *store) profilesDir() string { return filepath.Join(s.dir, "profiles") }
func (s *store) workDir() string     { return filepath.Join(s.dir, "work") }

// settings returns a copy of the settings.
func (s *store) settings() settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	set := s.set
	set.Remote = make(map[string]*Remote, len(s.set.Remote))
	for name, r := range s.set.Remote {
		copied := *r
		set.Remote[name] = &copied
	}
	return set
}

func (s *store) update(fn func(*settings)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.set)
	s.saveLocked()
}

func (s *store) saveLocked() {
	data, _ := stdjson.MarshalIndent(s.set, "", "  ")
	os.WriteFile(filepath.Join(s.dir, "settings.json"), data, 0o644)
}

// profiles lists the profiles by name.
func (s *store) profiles() ([]profile, error) {
	entries, err := os.ReadDir(s.profilesDir())
	if err != nil {
		return nil, err
	}
	var list []profile
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || e.IsDir() || strings.HasPrefix(name, ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, profile{Name: name, Path: filepath.Join(s.profilesDir(), e.Name()), Size: info.Size(), ModTime: info.ModTime()})
	}
	slices.SortFunc(list, func(a, b profile) int { return strings.Compare(a.Name, b.Name) })
	return list, nil
}

func (s *store) path(name string) string {
	return filepath.Join(s.profilesDir(), name+".json")
}

func (s *store) read(name string) ([]byte, error) {
	return os.ReadFile(s.path(name))
}

var errBadName = errors.New("名称不能为空，也不能包含 / 或以 . 开头")

func validName(name string) bool {
	return name != "" && !strings.ContainsAny(name, `/\:`) && !strings.HasPrefix(name, ".")
}

func (s *store) write(name string, content []byte) error {
	if !validName(name) {
		return errBadName
	}
	// A file of its own for every write, so that saves at once cannot
	// interleave; renamed over the profile, so that it is never half
	// written.
	f, err := os.CreateTemp(s.profilesDir(), "."+name+".*.tmp")
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
	return os.Rename(f.Name(), s.path(name))
}

// importFile copies a configuration into the profiles, under a name that
// is not taken, and returns the name.
func (s *store) importFile(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	return s.create(base, content)
}

// create writes a new profile under base, or base 2, base 3… when taken.
func (s *store) create(base string, content []byte) (string, error) {
	base = strings.TrimSpace(strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(base))
	base = strings.TrimLeft(base, ".")
	if base == "" {
		base = "配置"
	}
	s.files.Lock()
	defer s.files.Unlock()
	name := base
	for i := 2; ; i++ {
		if _, err := os.Stat(s.path(name)); errors.Is(err, os.ErrNotExist) {
			break
		}
		name = base + " " + itoa(i)
	}
	return name, s.write(name, content)
}

func (s *store) rename(from, to string) error {
	if from == to {
		return nil
	}
	if !validName(to) {
		return errBadName
	}
	s.files.Lock()
	defer s.files.Unlock()
	// A name that differs only in case is the same file on APFS.
	if target, err := os.Stat(s.path(to)); err == nil {
		if source, err := os.Stat(s.path(from)); err != nil || !os.SameFile(source, target) {
			return errors.New("已有名为“" + to + "”的配置")
		}
	}
	if err := os.Rename(s.path(from), s.path(to)); err != nil {
		return err
	}
	s.update(func(set *settings) {
		if set.Active == from {
			set.Active = to
		}
		if r, ok := set.Remote[from]; ok {
			delete(set.Remote, from)
			set.Remote[to] = r
		}
	})
	return nil
}

// trash moves a file to the Trash; tests remove it.
var trash = os.Remove

func (s *store) remove(name string) error {
	if err := trash(s.path(name)); err != nil {
		return err
	}
	s.update(func(set *settings) {
		if set.Active == name {
			set.Active = ""
		}
		delete(set.Remote, name)
	})
	return nil
}

// setRemote records where a profile comes from, nil when it is local.
func (s *store) setRemote(name string, r *Remote) {
	s.update(func(set *settings) {
		if r == nil {
			delete(set.Remote, name)
			return
		}
		if set.Remote == nil {
			set.Remote = map[string]*Remote{}
		}
		copied := *r
		normalizeRemote(&copied)
		set.Remote[name] = &copied
	})
}

const sampleName = "本地代理示例"

// sampleProfile listens on 127.0.0.1:2080 only, sends everything direct,
// and changes nothing in the system: no TUN, no system proxy.
const sampleProfile = `{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "inbounds": [
    {
      "type": "mixed",
      "tag": "mixed-in",
      "listen": "127.0.0.1",
      "listen_port": 2080
    }
  ],
  "outbounds": [
    {
      "type": "selector",
      "tag": "proxy",
      "outbounds": ["direct"]
    },
    {
      "type": "direct",
      "tag": "direct"
    }
  ],
  "route": {
    "final": "proxy"
  }
}
`
