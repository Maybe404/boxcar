package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeCore stands in for sing-box: it never starts one.
type fakeCore struct {
	status  coreStatus
	started int
	content []byte
	logs    *logBuffer
}

func (f *fakeCore) Status() coreStatus   { return f.status }
func (f *fakeCore) Profile() string      { return "" }
func (f *fakeCore) StartedAt() time.Time { return time.Time{} }
func (f *fakeCore) LastError() error     { return nil }
func (f *fakeCore) Logs() *logBuffer     { return f.logs }
func (f *fakeCore) Start(_ string, content []byte) error {
	f.started++
	f.status, f.content = statusRunning, content
	return nil
}
func (f *fakeCore) Stop() error                                { f.status, f.content = statusStopped, nil; return nil }
func (f *fakeCore) Shutdown()                                  { f.Stop() }
func (f *fakeCore) Content() []byte                            { return f.content }
func (f *fakeCore) Stats() Stats                               { return Stats{} }
func (f *fakeCore) Groups() []OutboundGroup                    { return nil }
func (f *fakeCore) Chain() []string                            { return nil }
func (f *fakeCore) SelectOutbound(_, _ string) error           { return nil }
func (f *fakeCore) URLTest(string)                             {}
func (f *fakeCore) TestOutbound(string) (int, error)           { return 0, nil }
func (f *fakeCore) Mode() ModeState                            { return ModeState{List: []string{}} }
func (f *fakeCore) SetMode(string) error                       { return nil }
func (f *fakeCore) Connections(bool) []Connection              { return nil }
func (f *fakeCore) CloseConnection(string)                     {}
func (f *fakeCore) CloseAllConnections()                       {}
func (f *fakeCore) ClearClosedConnections()                    {}
func (f *fakeCore) Warnings() []Warning                        { return nil }
func (f *fakeCore) Rules() []RuleInfo                          { return nil }
func (f *fakeCore) ClearDNSCache()                             {}
func (f *fakeCore) ResetFakeIP() error                         { return nil }
func (f *fakeCore) QueryDNS(string, string) (DNSResult, error) { return DNSResult{}, errNotRunning }
func (f *fakeCore) LogLevel() string                           { return "" }

func newTestBox(t *testing.T) (*Box, *fakeCore) {
	dir := t.TempDir()
	st, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	core := &fakeCore{logs: newLogBuffer(10)}
	return newBox(core, st, newSystemProxy(filepath.Join(dir, "system-proxy.json"))), core
}

func TestStateDoesNotStart(t *testing.T) {
	b, core := newTestBox(t)
	s := b.State()
	if s.Status != StatusStopped || core.started != 0 {
		t.Fatalf("status %s, started %d", s.Status, core.started)
	}
}

func lineOf(b *Box) string {
	var parts []string
	for _, s := range b.State().Line {
		parts = append(parts, s.Title+":"+string(s.Kind))
	}
	return strings.Join(parts, " ")
}

func TestLineOfSample(t *testing.T) {
	b, _ := newTestBox(t)
	if got, want := lineOf(b), "本机:device mixed-in:inbound proxy:group direct:node 互联网:internet"; got != want {
		t.Fatalf("line\n got %s\nwant %s", got, want)
	}
}

func TestLineFollowsRouteFinal(t *testing.T) {
	b, _ := newTestBox(t)
	config := `{
  "inbounds": [{"type": "socks", "tag": "s", "listen_port": 1080}, {"type": "http", "tag": "h", "listen": "127.0.0.1", "listen_port": 8080}],
  "outbounds": [
    {"type": "direct", "tag": "direct"},
    {"type": "selector", "tag": "proxy", "outbounds": ["auto", "direct"], "default": "auto"},
    {"type": "urltest", "tag": "auto", "outbounds": ["direct"]}
  ],
  "route": {"final": "proxy"}
}`
	if err := b.store.write("t", []byte(config)); err != nil {
		t.Fatal(err)
	}
	b.SetActive("t")
	if got, want := lineOf(b), "本机:device s:inbound h:inbound proxy:group auto:group 互联网:internet"; got != want {
		t.Fatalf("line\n got %s\nwant %s", got, want)
	}
	if d := b.State().Line[1].Detail; d != "socks · :1080" {
		t.Fatalf("detail %q", d)
	}
}

// The line of a running core is the configuration running, not the file
// edited since.
func TestLineOfRunningConfiguration(t *testing.T) {
	b, core := newTestBox(t)
	if err := b.Start(); err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(sampleProfile, "2080", "7890", 1)
	if err := b.store.write(sampleName, []byte(edited)); err != nil {
		t.Fatal(err)
	}
	if d := b.State().Line[1].Detail; d != "mixed · 127.0.0.1:2080" {
		t.Fatalf("running detail %q", d)
	}
	core.Stop()
	if d := b.State().Line[1].Detail; d != "mixed · 127.0.0.1:7890" {
		t.Fatalf("stopped detail %q", d)
	}
}

func TestCheckDoesNotStart(t *testing.T) {
	b, core := newTestBox(t)
	if r := b.CheckProfile(sampleProfile); !r.OK {
		t.Fatal(r.Error)
	}
	if r := b.CheckProfile(`{"inbounds":[{"type":"nope"}]}`); r.OK {
		t.Fatal("an unknown inbound passed the check")
	}
	if core.started != 0 {
		t.Fatal("checking started the core")
	}
}

func TestTakeover(t *testing.T) {
	if r := takeover(configJSON([]byte(sampleProfile))); len(r) != 0 {
		t.Fatalf("the sample takes over: %v", r)
	}
	for name, config := range map[string]string{
		"tun":          `{"inbounds":[{"type":"tun","address":["172.19.0.1/30"],"auto_route":true}]}`,
		"system proxy": `{"inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":7890,"set_system_proxy":true}]}`,
		"system time":  `{"ntp":{"enabled":true,"server":"time.apple.com","write_to_system":true}}`,
	} {
		if r := takeover(configJSON([]byte(config))); len(r) == 0 {
			t.Errorf("%s: no takeover found", name)
		}
	}
}

func TestFormatProfile(t *testing.T) {
	b, _ := newTestBox(t)
	out, err := b.FormatProfile(`{"outbounds":[{"type":"direct","tag":"d"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "\n  \"outbounds\": [") {
		t.Fatalf("not indented:\n%s", out)
	}
}

func TestActivityClassifies(t *testing.T) {
	for line, want := range map[string]ActivityKind{
		"[1234 5ms] dns: exchanged example.com. IN A":          ActivityDNS,
		"dns/https[cloudflare]: exchange failed":               ActivityDNS,
		"router: updated rule-set geosite-cn":                  ActivityRuleSet,
		"outbound/urltest[auto]: outbound HK available: 48ms":  ActivityURLTest,
		"ntp: updated time":                                    ActivityNTP,
		"inbound/mixed[mixed-in]: inbound connection to x:443": "",
	} {
		kind, _, ok := classify(line)
		if (want == "") == ok || kind != want {
			t.Errorf("%q: %q %v, want %q", line, kind, ok, want)
		}
	}
}

func TestLogLevelAndPrefix(t *testing.T) {
	b := newLogBuffer(10)
	b.setLevel(3) // warn
	b.WriteMessage(4, "INFO[0001] dns: lookup example.com")
	b.WriteMessage(2, "ERROR[0002] router: boom")
	lines, _ := b.snapshot(6, "", "")
	if len(lines) != 1 || lines[0].Message != "router: boom" || lines[0].Source != sourceCore {
		t.Fatalf("lines %+v", lines)
	}
	// The app's lines are kept whatever the configuration's level, and
	// apart by source.
	b.add(4, "系统代理已开启")
	if app, _ := b.snapshot(6, sourceApp, ""); len(app) != 1 || app[0].Message != "系统代理已开启" {
		t.Fatalf("app lines %+v", app)
	}
	if core, _ := b.snapshot(6, sourceCore, ""); len(core) != 1 {
		t.Fatalf("core lines %+v", core)
	}
	if acts := b.activity.list("", "", 10); len(acts) != 1 || acts[0].Kind != ActivityDNS {
		t.Fatalf("activity %+v", acts)
	}
}

func TestStoreWriteAndRename(t *testing.T) {
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.write("a", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	st.setRemote("a", &Remote{URL: "https://example.com/a.json"})
	if err := st.rename("a", "A"); err != nil {
		t.Fatalf("rename by case: %v", err)
	}
	if st.settings().Remote["A"] == nil {
		t.Fatal("the subscription did not follow the rename")
	}
	list, _ := st.profiles()
	for _, p := range list {
		if strings.HasPrefix(p.Name, ".") {
			t.Fatalf("a temporary file is listed: %s", p.Name)
		}
	}
}
