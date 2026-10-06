package main

import (
	"slices"
	"strings"
	"testing"
)

const mergeBase = `{
  "log": {"level": "info"},
  "outbounds": [
    {"type": "socks", "tag": "a", "server": "a.example.com", "server_port": 1080},
    {"type": "socks", "tag": "b", "server": "b.example.com", "server_port": 1080},
    {"type": "socks", "tag": "c", "server": "c.example.com", "server_port": 1080},
    {"type": "direct", "tag": "direct"}
  ],
  "route": {"rules": [{"domain_suffix": ["example.com"], "outbound": "a"}], "final": "a"}
}`

func mustMerge(t *testing.T, base, theirs, mine string) (map[string]any, []string, string) {
	t.Helper()
	out, conflicts, err := mergeConfig([]byte(base), []byte(theirs), []byte(mine))
	if err != nil {
		t.Fatal(err)
	}
	root := rawJSON(out)
	if root == nil {
		t.Fatalf("not JSON: %s", out)
	}
	return root, conflicts, string(out)
}

func outboundTags(root map[string]any) []string {
	var tags []string
	for _, o := range root["outbounds"].([]any) {
		tags = append(tags, o.(map[string]any)["tag"].(string))
	}
	return tags
}

func TestMergeKeepsBothSides(t *testing.T) {
	// Upstream: a moves server, d is added, c goes.
	theirs := strings.NewReplacer(`"a.example.com"`, `"a2.example.com"`,
		`{"type": "socks", "tag": "c", "server": "c.example.com", "server_port": 1080},`,
		`{"type": "socks", "tag": "d", "server": "d.example.com", "server_port": 1080},`).Replace(mergeBase)
	// Here: debug logs, b's port, a node of one's own, and a comment.
	mine := strings.NewReplacer(`"info"`, `"debug"`,
		`"b.example.com", "server_port": 1080`, `"b.example.com", "server_port": 2080`,
		`{"type": "direct", "tag": "direct"}`, `{"type": "direct", "tag": "direct"},
    // mine
    {"type": "socks", "tag": "own", "server": "own.example.com", "server_port": 1080}`).Replace(mergeBase)

	root, conflicts, text := mustMerge(t, mergeBase, theirs, mine)
	if len(conflicts) != 0 {
		t.Fatalf("conflicts %v", conflicts)
	}
	if got := outboundTags(root); !slices.Equal(got, []string{"a", "b", "d", "direct", "own"}) {
		t.Fatalf("outbounds %v", got)
	}
	outs := root["outbounds"].([]any)
	if outs[0].(map[string]any)["server"] != "a2.example.com" || outs[1].(map[string]any)["server_port"] != float64(2080) {
		t.Fatalf("outbounds %v", outs)
	}
	if root["log"].(map[string]any)["level"] != "debug" {
		t.Fatalf("log %v", root["log"])
	}
	// In the subscription's order.
	if strings.Index(text, `"log"`) > strings.Index(text, `"outbounds"`) || strings.Index(text, `"outbounds"`) > strings.Index(text, `"route"`) {
		t.Fatalf("order lost:\n%s", text)
	}
}

func TestMergeConflictKeepsMine(t *testing.T) {
	theirs := strings.Replace(mergeBase, `"a.example.com"`, `"up.example.com"`, 1)
	mine := strings.Replace(mergeBase, `"a.example.com"`, `"mine.example.com"`, 1)
	mine = strings.Replace(mine, `"final": "a"`, `"final": "b"`, 1)
	theirs = strings.Replace(theirs, `["example.com"]`, `["example.org"]`, 1)
	mine = strings.Replace(mine, `"outbound": "a"}]`, `"outbound": "b"}]`, 1)

	root, conflicts, _ := mustMerge(t, mergeBase, theirs, mine)
	if !slices.Equal(conflicts, []string{"outbounds[a].server", "route.rules"}) {
		t.Fatalf("conflicts %v", conflicts)
	}
	if root["outbounds"].([]any)[0].(map[string]any)["server"] != "mine.example.com" {
		t.Fatal("mine not kept")
	}
	rule := root["route"].(map[string]any)["rules"].([]any)[0].(map[string]any)
	if rule["outbound"] != "b" || root["route"].(map[string]any)["final"] != "b" {
		t.Fatalf("route %v", root["route"])
	}
}

func TestMergeDeletions(t *testing.T) {
	// Mine drops b; upstream drops c.
	mine := strings.Replace(mergeBase, `{"type": "socks", "tag": "b", "server": "b.example.com", "server_port": 1080},`, "", 1)
	theirs := strings.Replace(mergeBase, `{"type": "socks", "tag": "c", "server": "c.example.com", "server_port": 1080},`, "", 1)
	root, conflicts, _ := mustMerge(t, mergeBase, theirs, mine)
	if len(conflicts) != 0 || !slices.Equal(outboundTags(root), []string{"a", "direct"}) {
		t.Fatalf("outbounds %v, conflicts %v", outboundTags(root), conflicts)
	}
}

func TestMergeWithOneSideOnly(t *testing.T) {
	theirs := strings.Replace(mergeBase, `"info"`, `"warn"`, 1)
	out, conflicts, err := mergeConfig([]byte(mergeBase), []byte(theirs), []byte("// formatted\n"+mergeBase))
	if err != nil || len(conflicts) != 0 || string(out) != theirs {
		t.Fatalf("unchanged here: the download as it is, got %s %v %v", out, conflicts, err)
	}
	mine := strings.Replace(mergeBase, `"info"`, `"error"`, 1)
	out, _, _ = mergeConfig([]byte(mergeBase), []byte(mergeBase), []byte(mine))
	if string(out) != mine {
		t.Fatal("unchanged upstream: mine as it is")
	}
}

func TestSubscriptionUpdateKeepsEdits(t *testing.T) {
	b, _ := newTestBox(t)
	name, err := b.store.create("订阅", []byte(mergeBase))
	if err != nil {
		t.Fatal(err)
	}
	b.store.setSource(name, []byte(mergeBase), originSubscription, "")
	mine := strings.Replace(mergeBase, `"info"`, `"debug"`, 1)
	theirs := strings.Replace(mergeBase, `"a.example.com"`, `"a2.example.com"`, 1)

	// Not edited: the download replaces it.
	if out, _, err := b.mergeUpdate(name, []byte(mergeBase), []byte(theirs)); err != nil || string(out) != theirs {
		t.Fatalf("%s %v", out, err)
	}
	out, conflicts, err := b.mergeUpdate(name, []byte(mine), []byte(theirs))
	if err != nil || len(conflicts) != 0 || !strings.Contains(string(out), `"debug"`) || !strings.Contains(string(out), "a2.example.com") {
		t.Fatalf("%s %v %v", out, conflicts, err)
	}
	// A merge that does not check out leaves the profile.
	broken := strings.Replace(mergeBase, `"final": "a"`, `"final": "a", "bogus_option": 1`, 1)
	if _, _, err := b.mergeUpdate(name, []byte(mine), []byte(broken)); err == nil {
		t.Fatal("a merge that does not check out was kept")
	}
}

func TestMergeReadsWhatTheCoreReads(t *testing.T) {
	// Trailing commas and comments, which the core accepts.
	mine := strings.Replace(mergeBase, `"level": "info"}`, `"level": "debug",}, // here`, 1)
	theirs := strings.Replace(mergeBase, `"a.example.com"`, `"a2.example.com"`, 1)
	root, conflicts, _ := mustMerge(t, mergeBase, theirs, mine)
	if len(conflicts) != 0 || root["log"].(map[string]any)["level"] != "debug" || root["outbounds"].([]any)[0].(map[string]any)["server"] != "a2.example.com" {
		t.Fatalf("merged %v %v", root, conflicts)
	}
	// A comma in a string stays.
	if got := string(dropTrailingCommas([]byte(`{"a": "x,}", "b": [1, 2,],}`))); got != `{"a": "x,}", "b": [1, 2]}` {
		t.Fatalf("got %s", got)
	}
	if _, _, err := mergeConfig([]byte(mergeBase), []byte(theirs), []byte("  ")); err == nil || !strings.Contains(err.Error(), "空") {
		t.Fatalf("empty: %v", err)
	}
}

func TestMergeKeepsMyOrder(t *testing.T) {
	// Here: c first. Upstream: d added after b.
	mine := strings.Replace(mergeBase, `{"type": "socks", "tag": "c", "server": "c.example.com", "server_port": 1080},`, "", 1)
	mine = strings.Replace(mine, `"outbounds": [`, `"outbounds": [
    {"type": "socks", "tag": "c", "server": "c.example.com", "server_port": 1080},`, 1)
	theirs := strings.Replace(mergeBase, `{"type": "socks", "tag": "c",`, `{"type": "socks", "tag": "d", "server": "d.example.com", "server_port": 1080},
    {"type": "socks", "tag": "c",`, 1)
	theirs = strings.Replace(theirs, `"info"`, `"warn"`, 1)
	root, conflicts, _ := mustMerge(t, mergeBase, theirs, mine)
	if got := outboundTags(root); len(conflicts) != 0 || !slices.Equal(got, []string{"c", "a", "b", "d", "direct"}) {
		t.Fatalf("outbounds %v, conflicts %v", got, conflicts)
	}
}
