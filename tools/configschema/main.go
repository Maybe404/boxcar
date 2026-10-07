// Configschema copies the configuration schema of the core go.mod
// requires, and the Chinese descriptions of its fields, into the
// frontend: the visual editor is generated from them.
//
//	go run ./tools/configschema
//
// It writes frontend/src/config/gen/schema.json, the core's
// docs/schema.json; frontend/src/config/gen/docs.json, the text under
// every "#### field" heading of docs/configuration/**/*.zh.md, keyed by
// the document ("outbound/vless", "shared/dial", "route") and the field;
// and frontend/src/config/gen/examples.json, the example configurations
// of the documentation, which the tests open and save in the editor.
package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	sjson "github.com/sagernet/sing/common/json"
)

const out = "frontend/src/config/gen"

// Field is what the documentation says about a field.
type Field struct {
	Text     string `json:"text,omitempty"`
	Required bool   `json:"required,omitempty"`
	// Scope is where the field applies, as 仅客户端.
	Scope string `json:"scope,omitempty"`
	Since string `json:"since,omitempty"`
	// Deprecated is the notice of the field itself: deprecated, removed,
	// or not recommended.
	Deprecated string `json:"deprecated,omitempty"`
	// Values are the values the documentation lists as available.
	Values []string `json:"values,omitempty"`
}

// Docs are the fields of every document, and the version they describe.
type Docs struct {
	Version string                      `json:"version"`
	Docs    map[string]map[string]Field `json:"docs"`
}

func main() {
	dir := goList("{{.Dir}}")
	version := strings.TrimPrefix(goList("{{.Version}}"), "v")
	if err := os.MkdirAll(out, 0o755); err != nil {
		log.Fatal(err)
	}

	// The schema, compact.
	raw, err := os.ReadFile(filepath.Join(dir, "docs", "schema.json"))
	if err != nil {
		log.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		log.Fatal(err)
	}
	write("schema.json", compact.Bytes())

	// The descriptions.
	docs := Docs{Version: version, Docs: map[string]map[string]Field{}}
	root := filepath.Join(dir, "docs", "configuration")
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".zh.md") {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		key := strings.TrimSuffix(filepath.ToSlash(rel), ".zh.md")
		key = strings.TrimSuffix(strings.TrimSuffix(key, "index"), "/")
		if key == "" {
			key = "index"
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if fields := parse(string(content)); len(fields) > 0 {
			docs.Docs[key] = fields
		}
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
	data, err := json.Marshal(docs)
	if err != nil {
		log.Fatal(err)
	}
	write("docs.json", data)
	n := 0
	for _, f := range docs.Docs {
		n += len(f)
	}
	examples := collectExamples(filepath.Join(dir, "docs"))
	data, err = json.Marshal(examples)
	if err != nil {
		log.Fatal(err)
	}
	write("examples.json", data)
	log.Printf("core %s: %d documents, %d fields, %d examples", version, len(docs.Docs), n, len(examples))
}

// Example is a configuration the documentation shows, whole.
type Example struct {
	Source string         `json:"source"`
	Config map[string]any `json:"config"`
}

var (
	jsonBlock = regexp.MustCompile("(?s)```json\\n(.*?)```")
	sections  = map[string]bool{"log": true, "dns": true, "ntp": true, "certificate": true, "certificate_providers": true, "http_clients": true, "network_namespaces": true, "endpoints": true, "inbounds": true, "outbounds": true, "route": true, "services": true, "experimental": true}
)

// collectExamples reads the JSON blocks of the documentation that are
// configurations: they parse, and have only the configuration's sections.
func collectExamples(root string) []Example {
	var out []Example
	seen := map[string]bool{}
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".md") {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		for _, m := range jsonBlock.FindAllStringSubmatch(string(content), -1) {
			config, err := sjson.UnmarshalExtended[map[string]any]([]byte(m[1]))
			if err != nil || len(config) == 0 {
				continue
			}
			whole := true
			for k := range config {
				whole = whole && sections[k]
			}
			key, _ := json.Marshal(config)
			if !whole || seen[string(key)] {
				continue
			}
			seen[string(key)] = true
			out = append(out, Example{Source: filepath.ToSlash(rel), Config: config})
		}
		return nil
	})
	return out
}

func goList(format string) string {
	// go list names no directory for a module not yet downloaded, as on
	// a fresh CI runner.
	download := exec.Command("go", "mod", "download", "github.com/sagernet/sing-box")
	download.Stderr = os.Stderr
	if err := download.Run(); err != nil {
		log.Fatal(err)
	}
	cmd := exec.Command("go", "list", "-m", "-f", format, "github.com/sagernet/sing-box")
	cmd.Stderr = os.Stderr
	b, err := cmd.Output()
	if err != nil {
		log.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

func write(name string, data []byte) {
	if err := os.WriteFile(filepath.Join(out, name), append(data, '\n'), 0o644); err != nil {
		log.Fatal(err)
	}
}

var (
	heading   = regexp.MustCompile(`^(#{2,6})\s+(.*?)\s*$`)
	fieldName = regexp.MustCompile(`^[a-z0-9_$]+(\s*,\s*[a-z0-9_]+)*$`)
	material  = regexp.MustCompile(`:material-[a-z0-9-]+:`)
	link      = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	refLink   = regexp.MustCompile(`\[([^\]]+)\]\[[^\]]*\]`)
	admonish  = regexp.MustCompile(`^(!!!|\?\?\?)\s*(\w+)\s*(?:"([^"]*)")?`)
	version   = regexp.MustCompile(`\d+\.\d+(\.\d+)?`)
	// A line of its own as ==仅客户端==.
	marker = regexp.MustCompile(`^==([^=]+)==$`)
	bullet = regexp.MustCompile("^[*-]\\s+`?([A-Za-z0-9_.:/+-]+)`?(\\s|$|（|\\(|：|:|，|,)")
	// What introduces a list of values.
	intro    = regexp.MustCompile(`可用值|可选值|可用的|可以是|可选的|[：:]$`)
	backtick = regexp.MustCompile("`([^`\\s]+)`")
)

// parse reads the fields of a document: every heading that is a field
// name, with the text up to the next heading. The admonitions right under
// the heading are about the field itself: since when, deprecated.
func parse(md string) map[string]Field {
	fields := map[string]Field{}
	var names []string
	var body []string
	var since, deprecated string
	inFence, inAdmonition := false, false
	flush := func() {
		if len(names) == 0 {
			return
		}
		f := clean(body)
		f.Since, f.Deprecated = since, deprecated
		for _, n := range names {
			if _, ok := fields[n]; !ok {
				fields[n] = f
			}
		}
	}
	started := func() bool {
		for _, l := range body {
			if t := strings.TrimSpace(l); t != "" && !marker.MatchString(t) {
				return true
			}
		}
		return false
	}
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if m := heading.FindStringSubmatch(line); m != nil {
			flush()
			names, body, since, deprecated = nil, nil, "", ""
			inAdmonition = false
			title := strings.TrimSpace(material.ReplaceAllString(m[2], ""))
			title = strings.Trim(title, "`")
			if len(m[1]) >= 3 && fieldName.MatchString(title) {
				for _, n := range strings.Split(title, ",") {
					names = append(names, strings.TrimSpace(n))
				}
			}
			continue
		}
		if names == nil {
			continue
		}
		if m := admonish.FindStringSubmatch(line); m != nil {
			inAdmonition = true
			title := m[3]
			if !started() {
				switch {
				case m[2] == "question" && strings.Contains(title, "起"):
					since = version.FindString(title)
				case strings.Contains(title, "废弃") || strings.Contains(title, "移除") || strings.Contains(title, "不推荐"):
					deprecated = renameCore(title)
				}
			}
			continue
		}
		if inAdmonition {
			// The body of an admonition is indented.
			if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
				continue
			}
			inAdmonition = false
		}
		body = append(body, line)
	}
	flush()
	return fields
}

// clean turns the body of a field into plain text: paragraphs, lists and
// tables kept as lines, links reduced to their text.
func clean(lines []string) Field {
	var f Field
	var kept []string
	blank := false
	listing := false
	seen := map[string]bool{}
	value := func(v string) {
		if !seen[v] {
			seen[v] = true
			f.Values = append(f.Values, v)
		}
	}
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		if m := marker.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			switch m[1] {
			case "必填", "Required":
				f.Required = true
			default:
				f.Scope = m[1]
			}
			continue
		}
		if strings.Contains(line, "==必填==") || strings.Contains(line, "==Required==") {
			f.Required = true
			line = strings.TrimSpace(strings.NewReplacer("==必填==", "", "==Required==", "").Replace(line))
		}
		line = strings.ReplaceAll(line, "==", "")
		line = material.ReplaceAllString(line, "")
		line = link.ReplaceAllString(line, "$1")
		line = refLink.ReplaceAllString(line, "$1")
		line = renameCore(line)
		// The values listed after 可用值 or 可选值, as bullets or code.
		if intro.MatchString(strings.TrimSpace(line)) {
			listing = true
			if i := strings.IndexAny(line, "：:"); i >= 0 {
				for _, m := range backtick.FindAllStringSubmatch(line[i:], -1) {
					value(m[1])
				}
			}
		}
		if t := strings.TrimSpace(line); listing {
			if m := bullet.FindStringSubmatch(t); m != nil {
				value(m[1])
			} else if t != "" && !intro.MatchString(t) {
				listing = false
			}
		}
		// Tables whose first cell is a value.
		if t := strings.TrimSpace(line); strings.HasPrefix(t, "|") {
			if m := backtick.FindStringSubmatch(strings.SplitN(strings.Trim(t, "|"), "|", 2)[0]); m != nil {
				value(m[1])
			}
		}
		// Tables: drop the rule, keep the cells.
		if t := strings.TrimSpace(line); strings.HasPrefix(t, "|") {
			if strings.Trim(t, "|-: ") == "" {
				continue
			}
			cells := strings.Split(strings.Trim(t, "|"), "|")
			for i := range cells {
				cells[i] = strings.TrimSpace(cells[i])
			}
			line = strings.Join(cells, " · ")
		}
		if strings.TrimSpace(line) == "" {
			blank = len(kept) > 0
			continue
		}
		if blank {
			kept = append(kept, "")
			blank = false
		}
		kept = append(kept, strings.TrimSpace(line))
	}
	f.Text = strings.Join(kept, "\n")
	if r := []rune(f.Text); len(r) > 900 {
		f.Text = strings.TrimSpace(string(r[:900])) + "…"
	}
	return f
}

// coreName is the name the interface does not use; in prose it is 内核.
var coreName = regexp.MustCompile(`(^|[^\w./-])sing-box($|[^\w./-])`)

var (
	hanBefore = regexp.MustCompile(`(\p{Han}) 内核`)
	hanAfter  = regexp.MustCompile(`内核 (\p{Han})`)
)

// renameCore calls the core 内核 in prose, and leaves code and addresses
// as they are: a command, a value or a URL keeps working only as written.
func renameCore(line string) string {
	parts := strings.Split(line, "`")
	for i := 0; i < len(parts); i += 2 {
		parts[i] = coreName.ReplaceAllString(parts[i], "${1}内核${2}")
		// No space between it and Chinese, as there was around the name.
		parts[i] = hanBefore.ReplaceAllString(parts[i], "${1}内核")
		parts[i] = hanAfter.ReplaceAllString(parts[i], "内核${1}")
	}
	return strings.Join(parts, "`")
}
