package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// snapshotDir lists every file of a directory with its content and time.
func snapshotDir(t *testing.T, dir string) string {
	t.Helper()
	var b strings.Builder
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		info, _ := d.Info()
		b.WriteString(path + " " + info.ModTime().String() + "\n")
		if !d.IsDir() {
			data, _ := os.ReadFile(path)
			b.Write(data)
		}
		return nil
	})
	return b.String()
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyImport(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "SingBox")
	writeFile(t, filepath.Join(old, "profiles", "家里.json"), `{"outbounds":[{"type":"direct","tag":"direct"}]}`)
	writeFile(t, filepath.Join(old, "profiles", "机场.json"), `{"log":{"level":"warn"}}`)
	writeFile(t, filepath.Join(old, "profiles", sampleName+".json"), sampleProfile)
	writeFile(t, filepath.Join(old, "settings.json"), `{"active":"机场","theme":"dark","systemProxy":true,"remote":{"机场":{"url":"https://example.com/sub","autoUpdate":true,"interval":60,"updatedAt":"2026-01-01T00:00:00Z"}}}`)
	before := snapshotDir(t, old)

	st, err := openStore(filepath.Join(root, "Boxcar"))
	if err != nil {
		t.Fatal(err)
	}
	offer := st.legacy()
	if !offer.Available || len(offer.Profiles) != 3 {
		t.Fatalf("offer %+v", offer)
	}

	r, err := st.importLegacy()
	if err != nil || len(r.Failed) != 0 {
		t.Fatalf("import %+v %v", r, err)
	}
	// The sample is the same as the one here: not copied twice.
	if strings.Join(r.Names, ",") != "家里,机场" {
		t.Fatalf("imported %v", r.Names)
	}
	set := st.settings()
	if set.Active != "机场" || set.Theme != "dark" || set.Remote["机场"] == nil || set.Remote["机场"].URL != "https://example.com/sub" {
		t.Fatalf("settings %+v", set)
	}
	if set.SystemProxy {
		t.Fatal("the system proxy setting was imported")
	}
	if content, _ := st.read("家里"); string(content) != `{"outbounds":[{"type":"direct","tag":"direct"}]}` {
		t.Fatalf("content %s", content)
	}
	if snapshotDir(t, old) != before {
		t.Fatal("the old directory changed")
	}
	// Offered once, imported once.
	if st.legacy().Available {
		t.Fatal("offered again after the import")
	}
	if again, _ := st.importLegacy(); len(again.Names) != 0 {
		t.Fatalf("imported twice: %v", again.Names)
	}
}

func TestLegacyOffer(t *testing.T) {
	root := t.TempDir()
	st, err := openStore(filepath.Join(root, "Boxcar"))
	if err != nil {
		t.Fatal(err)
	}
	if st.legacy().Available {
		t.Fatal("offered without an old directory")
	}
	// Only the same sample there: nothing an import would copy.
	writeFile(t, filepath.Join(root, "SingBox", "profiles", sampleName+".json"), sampleProfile)
	if st.legacy().Available {
		t.Fatal("offered with nothing to copy")
	}
	writeFile(t, filepath.Join(root, "SingBox", "profiles", "a.json"), "{}")
	if !st.legacy().Available {
		t.Fatal("not offered")
	}
	// Not once the sample was edited, or a profile added.
	if err := st.write(sampleName, []byte(strings.Replace(sampleProfile, "2080", "2081", 1))); err != nil {
		t.Fatal(err)
	}
	if st.legacy().Available {
		t.Fatal("offered over an edited profile")
	}
	if err := st.write(sampleName, []byte(sampleProfile)); err != nil {
		t.Fatal(err)
	}
	// Declined: not offered again, even after a restart.
	st.update(func(s *settings) { s.LegacyOffered = true })
	again, err := openStore(st.dir)
	if err != nil {
		t.Fatal(err)
	}
	if again.legacy().Available {
		t.Fatal("offered again once declined")
	}
}
