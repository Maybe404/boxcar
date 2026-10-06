package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSourceFollowsTheProfile(t *testing.T) {
	b, _ := newTestBox(t)
	st := b.store
	if o := st.settings().Origins[sampleName]; o == nil || o.Kind != originSample {
		t.Fatalf("sample origin %+v", o)
	}

	src := filepath.Join(t.TempDir(), "机场.json")
	writeFile(t, src, `{"outbounds": [{"type": "direct", "tag": "d"}]}`)
	r := b.ImportFiles([]string{src})
	if len(r.Names) != 1 {
		t.Fatalf("import %+v", r)
	}
	name := r.Names[0]
	if o := st.settings().Origins[name]; o == nil || o.Kind != originImport || o.From == "" || !o.SavedAt.IsZero() {
		t.Fatalf("import origin %+v", o)
	}
	if st.edited(name) {
		t.Fatal("edited as imported")
	}

	// Formatted differently and commented, it says the same.
	if err := b.SaveProfile(name, "{\n  // a note\n  \"outbounds\": [\n    {\"type\": \"direct\", \"tag\": \"d\"}\n  ]\n}\n"); err != nil {
		t.Fatal(err)
	}
	if st.edited(name) {
		t.Fatal("edited by formatting alone")
	}
	if err := b.SaveProfile(name, `{"outbounds": [{"type": "direct", "tag": "d2"}]}`); err != nil {
		t.Fatal(err)
	}
	if !st.edited(name) || st.settings().Origins[name].SavedAt.IsZero() {
		t.Fatal("an edit not noticed")
	}
	if source, _ := b.ReadSource(name); source != `{"outbounds": [{"type": "direct", "tag": "d"}]}` {
		t.Fatalf("source %q", source)
	}

	if err := b.RenameProfile(name, "改名"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.ReadSource("改名"); err != nil || st.settings().Origins["改名"] == nil || st.settings().Origins[name] != nil {
		t.Fatalf("source not renamed: %v", err)
	}
	if err := b.DeleteProfile("改名"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(st.sourcePath("改名")); !os.IsNotExist(err) || st.settings().Origins["改名"] != nil {
		t.Fatal("source left behind")
	}
}

func TestProfilesFromBeforeSourcesGetOne(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "profiles", "旧配置.json"), `{"log": {}}`)
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if source, err := st.source("旧配置"); err != nil || string(source) != `{"log": {}}` {
		t.Fatalf("source %q %v", source, err)
	}
	if o := st.settings().Origins["旧配置"]; o == nil || o.Kind != originUnknown {
		t.Fatalf("origin %+v", o)
	}
	if list, _ := st.profiles(); len(list) != 1 {
		t.Fatalf("the sources are listed as profiles: %+v", list)
	}
}

func TestRunningStaleOnceSaved(t *testing.T) {
	b, core := newTestBox(t)
	if err := b.Start(); err != nil {
		t.Fatal(err)
	}
	if p := b.Profiles(); p.Running != sampleName || p.RunningStale {
		t.Fatalf("just started: %+v", p)
	}
	if err := b.SaveProfile(sampleName, `{"log": {"level": "debug"}}`); err != nil {
		t.Fatal(err)
	}
	if p := b.Profiles(); !p.RunningStale {
		t.Fatal("a save while running not noticed")
	}
	if running, _ := b.RunningProfile(); running != string(core.content) || running == `{"log": {"level": "debug"}}` {
		t.Fatalf("running %q", running)
	}
}

func TestRunningRenamedIsNotStale(t *testing.T) {
	b, _ := newTestBox(t)
	if err := b.Start(); err != nil {
		t.Fatal(err)
	}
	if err := b.RenameProfile(sampleName, "改名"); err != nil {
		t.Fatal(err)
	}
	if p := b.Profiles(); p.RunningStale {
		t.Fatalf("stale once renamed: %+v", p)
	}
	if _, err := b.ReadSource("改名"); err != nil {
		t.Fatal("source not renamed")
	}
}
