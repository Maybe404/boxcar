package main

import (
	"bytes"
	stdjson "encoding/json"
	"os"
	"path/filepath"

	"github.com/sagernet/sing-box/log"
)

// Before it was renamed, the app was SingBox, and kept its data in
// ~/Library/Application Support/SingBox. Its profiles, subscriptions,
// active profile and theme can be copied over once; the old directory is
// left as it is.

// LegacyData is what the app named SingBox left, offered for import.
type LegacyData struct {
	// Available is whether to offer it: the old directory has profiles,
	// this one only the sample, and the offer was not answered.
	Available bool     `json:"available"`
	Dir       string   `json:"dir"`
	Profiles  []string `json:"profiles"`
}

// legacyDir is where the app kept its data under its old name.
func legacyDir(dir string) string { return filepath.Join(filepath.Dir(dir), "SingBox") }

// legacy returns what to offer from the old directory.
func (s *store) legacy() LegacyData {
	old := legacyDir(s.dir)
	data := LegacyData{Dir: abbreviateHome(old), Profiles: []string{}}
	if s.settings().LegacyOffered || old == s.dir {
		return data
	}
	copies := false
	for _, p := range legacyProfiles(old) {
		data.Profiles = append(data.Profiles, p.Name)
		copies = copies || !s.has(p)
	}
	data.Available = copies && s.onlySample()
	return data
}

// onlySample reports whether the profiles are none, or the sample as it
// was written.
func (s *store) onlySample() bool {
	list, _ := s.profiles()
	switch len(list) {
	case 0:
		return true
	case 1:
		content, err := s.read(list[0].Name)
		return list[0].Name == sampleName && err == nil && bytes.Equal(content, []byte(sampleProfile))
	}
	return false
}

// has reports whether a profile the same as p, by name and content, is
// here already, which an import would not copy.
func (s *store) has(p profile) bool {
	content, err := os.ReadFile(p.Path)
	if err != nil {
		return false
	}
	existing, err := s.read(p.Name)
	return err == nil && bytes.Equal(existing, content)
}

func legacyProfiles(old string) []profile {
	st := &store{dir: old}
	list, _ := st.profiles()
	return list
}

// importLegacy copies the old profiles in, with their subscriptions, and
// the active profile and theme. A profile the same as one here is not
// copied twice. Nothing in the old directory changes.
func (s *store) importLegacy() (ImportResult, error) {
	old := legacyDir(s.dir)
	r := ImportResult{Names: []string{}, Failed: []string{}}
	// Once is enough: a second call would copy what was edited since.
	if s.settings().LegacyOffered {
		return r, nil
	}
	var set settings
	if data, err := os.ReadFile(filepath.Join(old, "settings.json")); err == nil {
		stdjson.Unmarshal(data, &set)
	}
	names := map[string]string{}
	for _, p := range legacyProfiles(old) {
		content, err := os.ReadFile(p.Path)
		if err != nil {
			r.Failed = append(r.Failed, p.Name+"："+err.Error())
			continue
		}
		if s.has(p) {
			names[p.Name] = p.Name
			continue
		}
		name, err := s.create(p.Name, content)
		if err != nil {
			r.Failed = append(r.Failed, p.Name+"："+err.Error())
			continue
		}
		names[p.Name] = name
		r.Names = append(r.Names, name)
	}
	s.update(func(cur *settings) {
		// When nothing could be copied, the offer stays, to try again.
		cur.LegacyOffered = len(r.Names) > 0 || len(r.Failed) == 0
		for from, remote := range set.Remote {
			if to, ok := names[from]; ok && remote != nil {
				if cur.Remote == nil {
					cur.Remote = map[string]*Remote{}
				}
				copied := *remote
				normalizeRemote(&copied)
				cur.Remote[to] = &copied
			}
		}
		if to, ok := names[set.Active]; ok {
			cur.Active = to
		}
		if set.Theme != "" {
			cur.Theme = set.Theme
		}
	})
	return r, nil
}

// LegacyData says whether to offer the profiles of the app's old name.
func (b *Box) LegacyData() LegacyData { return b.store.legacy() }

// ImportLegacy copies the profiles and settings of the app's old name in.
// The old directory is left as it is.
func (b *Box) ImportLegacy() (ImportResult, error) {
	r, err := b.store.importLegacy()
	for _, name := range r.Names {
		b.note(log.LevelInfo, "从旧版导入配置“%s”", name)
	}
	for _, failed := range r.Failed {
		b.note(log.LevelError, "从旧版导入失败：%s", failed)
	}
	applyTheme(b.store.settings().Theme)
	b.changed()
	return r, err
}

// DismissLegacy declines the offer, which is not made again.
func (b *Box) DismissLegacy() {
	b.store.update(func(s *settings) { s.LegacyOffered = true })
}
