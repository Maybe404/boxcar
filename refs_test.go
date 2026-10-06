package main

import (
	stdjson "encoding/json"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
)

const refsBase = `{
  "dns": {
    "servers": [
      {"type": "local", "tag": "local"},
      {"type": "https", "tag": "remote", "server": "1.1.1.1", "detour": "proxy"}
    ],
    "rules": [{"rule_set": "geosite-cn", "server": "local"}],
    "final": "remote"
  },
  "inbounds": [{"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2080}],
  "outbounds": [
    {"type": "selector", "tag": "proxy", "outbounds": ["auto", "direct"], "default": "auto"},
    {"type": "urltest", "tag": "auto", "outbounds": ["direct"]},
    {"type": "direct", "tag": "direct", "domain_resolver": "local"}
  ],
  "http_clients": [{"tag": "dl", "detour": "direct"}],
  "route": {
    "rules": [
      {"action": "sniff"},
      {"protocol": "dns", "action": "hijack-dns"},
      {"inbound": "mixed-in", "rule_set": ["geosite-cn"], "outbound": "direct"},
      {"type": "logical", "mode": "or", "rules": [{"rule_set": "geosite-cn"}, {"ip_is_private": true}], "action": "route", "outbound": "direct"}
    ],
    "rule_set": [
      {"type": "remote", "tag": "geosite-cn", "url": "https://example.com/geosite-cn.srs", "http_client": "dl"}
    ],
    "default_http_client": "dl",
    "final": "proxy"
  }
}`

func refsOf(t *testing.T, config string) []Problem {
	t.Helper()
	root := rawJSON([]byte(config))
	if root == nil {
		t.Fatalf("the configuration does not parse:\n%s", config)
	}
	return checkReferences(root)
}

func TestReferencesOfAGoodConfiguration(t *testing.T) {
	if p := refsOf(t, refsBase); len(p) != 0 {
		t.Fatalf("problems in a good configuration: %+v", p)
	}
	if p := refsOf(t, sampleProfile); len(p) != 0 {
		t.Fatalf("problems in the sample: %+v", p)
	}
	// Without outbounds the core adds "direct"; an untagged outbound is
	// named by its index.
	if p := refsOf(t, `{"route": {"final": "direct"}}`); len(p) != 0 {
		t.Fatalf("implicit direct: %+v", p)
	}
	if p := refsOf(t, `{"outbounds": [{"type": "direct"}], "route": {"final": "0"}}`); len(p) != 0 {
		t.Fatalf("untagged outbound: %+v", p)
	}
	// Endpoints alone are not outbounds: direct is still added, unless
	// the final outbound is an endpoint.
	if p := refsOf(t, `{"endpoints": [{"type": "wireguard", "tag": "wg"}], "route": {"rules": [{"outbound": "direct"}]}}`); len(p) != 0 {
		t.Fatalf("direct beside an endpoint: %+v", p)
	}
	if p := refsOf(t, `{"endpoints": [{"type": "wireguard", "tag": "wg"}], "route": {"rules": [{"outbound": "direct"}], "final": "wg"}}`); len(p) != 1 {
		t.Fatalf("direct with an endpoint as final: %+v", p)
	}
}

func TestReferenceErrors(t *testing.T) {
	for _, c := range []struct {
		name, from, to, path, message string
	}{
		{"rule set of a rule", `{"inbound": "mixed-in", "rule_set": ["geosite-cn"]`, `{"inbound": "mixed-in", "rule_set": ["geosite-us"]`, "route.rules[2].rule_set[0]", "规则集“geosite-us”"},
		{"rule set in a logical rule", `"rules": [{"rule_set": "geosite-cn"}, {"ip_is_private": true}]`, `"rules": [{"rule_set": "nope"}, {"ip_is_private": true}]`, "route.rules[3].rules[0].rule_set", "规则集“nope”"},
		{"outbound of a rule", `"ip_is_private": true}], "action": "route", "outbound": "direct"`, `"ip_is_private": true}], "action": "route", "outbound": "missing"`, "route.rules[3].outbound", "出站“missing”"},
		{"inbound of a rule", `{"inbound": "mixed-in",`, `{"inbound": "socks-in",`, "route.rules[2].inbound", "入站“socks-in”不存在，不影响启动"},
		{"route.final", `"final": "proxy"`, `"final": "gone"`, "route.final", "出站“gone”"},
		{"member of a group", `"outbounds": ["auto", "direct"]`, `"outbounds": ["auto", "香港"]`, "outbounds[0].outbounds[1]", "出站“香港”"},
		{"default of a selector", `"default": "auto"`, `"default": "fast"`, "outbounds[0].default", "出站“fast”"},
		{"detour of a DNS server", `"detour": "proxy"`, `"detour": "proxy2"`, "dns.servers[1].detour", "出站“proxy2”"},
		{"dns.final", `"final": "remote"`, `"final": "google"`, "dns.final", "DNS 服务器“google”"},
		{"server of a DNS rule", `"server": "local"}]`, `"server": "cn"}]`, "dns.rules[0].server", "DNS 服务器“cn”"},
		{"domain resolver", `"domain_resolver": "local"`, `"domain_resolver": "dns-direct"`, "outbounds[2].domain_resolver", "DNS 服务器“dns-direct”"},
		{"rule set of a DNS rule", `"rules": [{"rule_set": "geosite-cn", "server"`, `"rules": [{"rule_set": "geosite-jp", "server"`, "dns.rules[0].rule_set", "规则集“geosite-jp”"},
		{"http client of a rule set", `"http_client": "dl"`, `"http_client": "download"`, "route.rule_set[0].http_client", "HTTP 客户端“download”"},
		{"default_http_client", `"default_http_client": "dl"`, `"default_http_client": "x"`, "route.default_http_client", "HTTP 客户端“x”"},
		{"detour of an HTTP client", `{"tag": "dl", "detour": "direct"}`, `{"tag": "dl", "detour": "via"}`, "http_clients[0].detour", "出站“via”"},
		{"duplicate tag", `{"type": "direct", "tag": "direct", "domain_resolver"`, `{"type": "direct", "tag": "auto", "domain_resolver"`, "outbounds[2].tag", "“auto”重复"},
	} {
		t.Run(c.name, func(t *testing.T) {
			config := strings.Replace(refsBase, c.from, c.to, 1)
			if config == refsBase {
				t.Fatalf("the case does not change the configuration")
			}
			problems := refsOf(t, config)
			for _, p := range problems {
				if p.Path == c.path && strings.Contains(p.Message, c.message) {
					return
				}
			}
			t.Fatalf("want %s: %s, got %+v", c.path, c.message, problems)
		})
	}
}

func TestCheckReportsReferences(t *testing.T) {
	b, core := newTestBox(t)
	config := strings.Replace(refsBase, `"rule_set": ["geosite-cn"]`, `"rule_set": ["geosite-us"]`, 1)
	r := b.CheckProfile(config)
	if r.OK || len(r.Problems) != 1 || r.Problems[0].Path != "route.rules[2].rule_set[0]" {
		t.Fatalf("check %+v", r)
	}
	if core.started != 0 {
		t.Fatal("checking started the core")
	}
}

// The configurations the wizards make (frontend/src/config/config.test.ts
// writes them) are ones the core accepts, with no reference problems.
func TestWizardOutputsCheck(t *testing.T) {
	files, err := filepath.Glob("testdata/wizard/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no wizard outputs: %v", err)
	}
	b, core := newTestBox(t)
	for _, file := range files {
		content, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		r := b.CheckProfile(string(content))
		if !r.OK {
			t.Errorf("%s: %s %+v", file, r.Error, r.Problems)
		}
		// What the wizards write is not deprecated.
		for _, w := range r.Warnings {
			t.Errorf("%s: %s", file, w.Message)
		}
	}
	if core.started != 0 {
		t.Fatal("checking started the core")
	}
}

// The schema and documentation in the frontend are the core's go.mod
// requires: go run ./tools/configschema after changing its version.
func TestGeneratedSchemaFollowsCore(t *testing.T) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Skip("no build info")
	}
	var want string
	for _, dep := range info.Deps {
		if dep.Path == "github.com/sagernet/sing-box" {
			want = strings.TrimPrefix(dep.Version, "v")
		}
	}
	if want == "" {
		t.Skip("the core is not a dependency of the build")
	}
	data, err := os.ReadFile("frontend/src/config/gen/docs.json")
	if err != nil {
		t.Fatal(err)
	}
	var docs struct {
		Version string `json:"version"`
	}
	if err := stdjson.Unmarshal(data, &docs); err != nil {
		t.Fatal(err)
	}
	if docs.Version != want {
		t.Fatalf("the editor's schema is of core %s, go.mod requires %s: run go run ./tools/configschema", docs.Version, want)
	}
}

// A missing inbound makes a rule match nothing, but the core starts.
func TestMissingInboundIsNotFatal(t *testing.T) {
	b, _ := newTestBox(t)
	r := b.CheckProfile(strings.Replace(refsBase, `{"inbound": "mixed-in",`, `{"inbound": "socks-in",`, 1))
	if !r.OK || len(r.Problems) != 1 || r.Problems[0].Fatal {
		t.Fatalf("check %+v", r)
	}
}
