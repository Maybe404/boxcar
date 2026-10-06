package main

import (
	"bytes"
	"context"
	stdjson "encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing/common/json"
)

// Status is where the core is in its life.
type Status string

const (
	StatusStopped  Status = "stopped"
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusStopping Status = "stopping"
)

func statusOf(s coreStatus) Status {
	switch s {
	case statusStarting:
		return StatusStarting
	case statusRunning:
		return StatusRunning
	case statusStopping:
		return StatusStopping
	default:
		return StatusStopped
	}
}

// StationKind is what a station of the line stands for.
type StationKind string

const (
	StationDevice   StationKind = "device"
	StationInbound  StationKind = "inbound"
	StationGroup    StationKind = "group"
	StationNode     StationKind = "node"
	StationInternet StationKind = "internet"
)

// Station is a stop on the way traffic takes through the core.
type Station struct {
	Kind StationKind `json:"kind"`
	// Title is the tag, or what the station is.
	Title string `json:"title"`
	// Detail is a short fact: an address, a type.
	Detail string `json:"detail,omitempty"`
}

// SystemProxyState is whether the system proxy points at sing-box.
type SystemProxyState struct {
	// Enabled is the setting: set it while sing-box runs.
	Enabled bool `json:"enabled"`
	// Active is whether the app has set it now, and Address where to.
	Active  bool   `json:"active"`
	Address string `json:"address,omitempty"`
	// Error is why setting it failed.
	Error string `json:"error,omitempty"`
}

// Snapshot is the state of the core, sent to the page as it changes.
type Snapshot struct {
	Status  Status `json:"status"`
	Profile string `json:"profile"`
	// StartedAt is when the core started, in Unix milliseconds; 0 while
	// stopped.
	StartedAt int64 `json:"startedAt"`
	// Error is why the last start failed.
	Error string    `json:"error,omitempty"`
	Stats Stats     `json:"stats"`
	Line  []Station `json:"line"`
	Mode  ModeState `json:"mode"`
	// Warnings are the deprecated parts of the configuration running.
	Warnings []Warning `json:"warnings"`
	// LogLevel is the level the configuration running logs at, or
	// "disabled" when it turns the log off.
	LogLevel    string           `json:"logLevel,omitempty"`
	SystemProxy SystemProxyState `json:"systemProxy"`
}

// LogLine is a line of the log: of the core, or of the app around it.
type LogLine struct {
	Time  time.Time `json:"time"`
	Level string    `json:"level"`
	// Source is "core" or "app".
	Source  string `json:"source"`
	Message string `json:"message"`
}

// Profile is a configuration file.
type Profile struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	// Remote is where the profile comes from, for a subscription.
	Remote *Remote `json:"remote"`
	// Origin is what the profile was imported, downloaded or created as.
	Origin *Origin `json:"origin"`
	// Edited is set when the profile says otherwise than its source.
	Edited bool `json:"edited"`
}

// Profiles are the configuration files, and the one Start runs.
type Profiles struct {
	Active string    `json:"active"`
	Items  []Profile `json:"items"`
	// Running is the profile the core runs, empty while stopped.
	Running string `json:"running"`
	// RunningStale is set when the profile running was saved since it
	// started: what runs is not what the profile says, until reloaded.
	RunningStale bool `json:"runningStale"`
}

// CheckResult is the outcome of checking a configuration.
type CheckResult struct {
	OK       bool      `json:"ok"`
	Error    string    `json:"error,omitempty"`
	Warnings []Warning `json:"warnings"`
	// Problems are references to tags nothing defines, which the core
	// would find only once started, and tags defined twice. Those not
	// fatal leave OK true.
	Problems []Problem `json:"problems"`
}

// ImportResult are the profiles an import made, and the files it could
// not import.
type ImportResult struct {
	Names  []string `json:"names"`
	Failed []string `json:"failed"`
}

// Theme is the appearance of the window.
type Theme string

const (
	ThemeSystem Theme = "system"
	ThemeLight  Theme = "light"
	ThemeDark   Theme = "dark"
)

// About describes the build.
type About struct {
	App      string   `json:"app"`
	Version  string   `json:"version"`
	Go       string   `json:"go"`
	Platform string   `json:"platform"`
	MyGo     string   `json:"mygo"`
	Tags     []string `json:"tags"`
	// Missing are the types this build leaves out, as "outbounds/naive":
	// a configuration using them fails to check or start.
	Missing []string `json:"missing"`
	DataDir string   `json:"dataDir"`
}

// StateChanged carries the state of the core to the page.
var StateChanged = mygo.NewEvent[Snapshot]("state")

// LogsChanged says the log, or the core's activity, has new lines.
var LogsChanged = mygo.NewEvent[int]("logs")

// ProfilesChanged says the profiles changed outside the page, as by an
// update of a subscription.
var ProfilesChanged = mygo.NewEvent[int]("profiles")

// Box is the service the page calls: the embedded sing-box and the
// profiles it runs.
type Box struct {
	core  Core
	store *store
	proxy *systemProxy

	// ops serializes starting, stopping and the system proxy.
	ops        sync.Mutex
	proxyError string

	// The line of a configuration, kept until it changes.
	lineMu   sync.Mutex
	lineKey  string
	lineBase []Station
	lineHint []string
	lineType map[string]string

	notify     chan struct{}
	logNotify  chan struct{}
	profilesV  int
	updateMu   sync.Mutex
	updatingMu sync.Mutex
	updating   map[string]bool
	// icons are the apps' icons the connections show.
	icons *iconCache
	// writes serializes a save from the page with a subscription update
	// merging into the same profile, so that neither is lost.
	writes sync.Mutex
	// onState follows the state, as the menu bar does.
	onState atomic.Pointer[func(Snapshot)]
}

func newBox(core Core, st *store, proxy *systemProxy) *Box {
	return &Box{
		core: core, store: st, proxy: proxy,
		notify: make(chan struct{}, 1), logNotify: make(chan struct{}, 1),
		updating: map[string]bool{},
		icons:    newIconCache(filepath.Join(st.dir, "icons")),
	}
}

// changed asks for the state to be sent to the page; changes in quick
// succession are sent once.
func (b *Box) changed() {
	select {
	case b.notify <- struct{}{}:
	default:
	}
}

// note logs what the app did around the core, as the log page shows it
// beside the core's lines.
func (b *Box) note(level log.Level, format string, args ...any) {
	b.core.Logs().add(level, fmt.Sprintf(format, args...))
}

// logged says the log has new lines, without recomputing the state.
func (b *Box) logged() {
	select {
	case b.logNotify <- struct{}{}:
	default:
	}
}

// broadcast sends the state, at most ten times a second.
func (b *Box) broadcast() {
	for range b.notify {
		state := b.State()
		StateChanged.Broadcast(state)
		if fn := b.onState.Load(); fn != nil {
			(*fn)(state)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// broadcastLogs says the log grew, at most four times a second.
func (b *Box) broadcastLogs() {
	version := 0
	for range b.logNotify {
		version++
		LogsChanged.Broadcast(version)
		time.Sleep(250 * time.Millisecond)
	}
}

// State returns the state of the core.
func (b *Box) State() Snapshot {
	status := b.core.Status()
	set := b.store.settings()
	s := Snapshot{Status: statusOf(status), Profile: b.core.Profile(), Warnings: []Warning{}, Mode: ModeState{List: []string{}}}
	if status == statusStopped {
		s.Profile = set.Active
	}
	if err := b.core.LastError(); err != nil && status == statusStopped {
		s.Error = err.Error()
	}
	running := status == statusRunning
	if running {
		s.StartedAt = b.core.StartedAt().UnixMilli()
		s.Stats = b.core.Stats()
		s.Mode = b.core.Mode()
		s.LogLevel = b.core.LogLevel()
	}
	if w := b.core.Warnings(); w != nil && status != statusStopped {
		s.Warnings = w
	}
	if s.Stats.UploadHistory == nil {
		s.Stats.UploadHistory, s.Stats.DownHistory = []int64{}, []int64{}
	}
	active, address := b.proxy.active()
	b.ops.Lock()
	proxyError := b.proxyError
	b.ops.Unlock()
	s.SystemProxy = SystemProxyState{Enabled: set.SystemProxy, Active: active, Address: address, Error: proxyError}
	s.Line = b.line(s.Profile, running)
	return s
}

// line is the way traffic takes: the device, the inbounds, the groups of
// the default route and the outbound they choose, the internet.
func (b *Box) line(profile string, running bool) []Station {
	base, hint, types := b.configLine(profile, running)
	chain := hint
	if running {
		if c := b.core.Chain(); len(c) > 0 {
			chain = c
		}
		for _, g := range b.core.Groups() {
			types[g.Tag] = g.Type
		}
	}
	line := []Station{{Kind: StationDevice, Title: "本机"}}
	line = append(line, base...)
	for i, tag := range chain {
		kind := StationGroup
		if i == len(chain)-1 && !isGroupType(types[tag]) {
			kind = StationNode
		}
		line = append(line, Station{Kind: kind, Title: tag, Detail: types[tag]})
	}
	return append(line, Station{Kind: StationInternet, Title: "互联网"})
}

func isGroupType(t string) bool { return t == C.TypeSelector || t == C.TypeURLTest }

// configJSON decodes a configuration into plain JSON, with the names of
// every field, as sing-box reads it. It is nil when it does not decode.
func configJSON(content []byte) map[string]any {
	if content == nil {
		return nil
	}
	options, err := parseOptions(content)
	if err != nil {
		return nil
	}
	canonical, err := json.MarshalContext(baseContext(), options)
	if err != nil {
		return nil
	}
	var root map[string]any
	stdjson.Unmarshal(canonical, &root)
	return root
}

// configLine returns the inbound stations of the configuration running,
// or of the profile while stopped; the chain of its default route as the
// file says it (the selectors' defaults); and the types of its outbounds
// by tag. The types are a copy the caller may change.
func (b *Box) configLine(profile string, running bool) ([]Station, []string, map[string]string) {
	var key string
	var content func() []byte
	if running {
		// What runs, not what the file says since.
		key = "run:" + profile + ":" + strconv.FormatInt(b.core.StartedAt().UnixNano(), 10)
		content = b.core.Content
	} else {
		key = "file:" + profile
		if info, err := os.Stat(b.store.path(profile)); profile != "" && err == nil {
			key += ":" + info.ModTime().String() + ":" + strconv.FormatInt(info.Size(), 10)
		}
		content = func() []byte {
			if profile == "" {
				return nil
			}
			data, _ := b.store.read(profile)
			return data
		}
	}
	b.lineMu.Lock()
	defer b.lineMu.Unlock()
	if key != b.lineKey || b.lineBase == nil {
		b.lineKey = key
		b.lineBase, b.lineHint, b.lineType = readLine(configJSON(content()))
	}
	types := make(map[string]string, len(b.lineType))
	for k, v := range b.lineType {
		types[k] = v
	}
	return b.lineBase, b.lineHint, types
}

func readLine(root map[string]any) ([]Station, []string, map[string]string) {
	stations := []Station{}
	for _, in := range inboundsOf(root) {
		detail := in.typ
		if in.port > 0 {
			detail = fmt.Sprintf("%s · %s:%d", in.typ, in.listen, in.port)
		}
		stations = append(stations, Station{Kind: StationInbound, Title: in.tag, Detail: detail})
	}
	// The default route: route.final, else the first outbound.
	outbounds := map[string]map[string]any{}
	types := map[string]string{}
	var first string
	for _, section := range []string{"outbounds", "endpoints"} {
		items, _ := root[section].([]any)
		for _, it := range items {
			obj, _ := it.(map[string]any)
			typ, _ := obj["type"].(string)
			tag, _ := obj["tag"].(string)
			if tag == "" {
				tag = typ
			}
			if first == "" && section == "outbounds" {
				first = tag
			}
			outbounds[tag], types[tag] = obj, typ
		}
	}
	current := first
	if route, ok := root["route"].(map[string]any); ok {
		if final, _ := route["final"].(string); final != "" {
			current = final
		}
	}
	var chain []string
	for current != "" && len(chain) < 16 {
		chain = append(chain, current)
		obj := outbounds[current]
		typ, _ := obj["type"].(string)
		if typ != C.TypeSelector {
			break // a urltest chooses once running
		}
		next, _ := obj["default"].(string)
		if next == "" {
			members, _ := obj["outbounds"].([]any)
			if len(members) > 0 {
				next, _ = members[0].(string)
			}
		}
		current = next
	}
	return stations, chain, types
}

// inbound is an inbound of a configuration, as far as the app needs it.
type inbound struct {
	tag, typ, listen string
	port             int
	systemProxy      bool
}

func inboundsOf(root map[string]any) []inbound {
	var out []inbound
	items, _ := root["inbounds"].([]any)
	for _, it := range items {
		obj, _ := it.(map[string]any)
		in := inbound{}
		in.typ, _ = obj["type"].(string)
		in.tag, _ = obj["tag"].(string)
		if in.tag == "" {
			in.tag = in.typ
		}
		in.listen, _ = obj["listen"].(string)
		if port, ok := obj["listen_port"].(float64); ok && port > 0 && port < 65536 {
			in.port = int(port)
		}
		in.systemProxy, _ = obj["set_system_proxy"].(bool)
		out = append(out, in)
	}
	return out
}

// Takeover lists what the active profile would change in the system's
// network once started: the page asks before starting it.
func (b *Box) Takeover() []string {
	content, err := b.store.read(b.store.settings().Active)
	if err != nil {
		return []string{}
	}
	return takeover(configJSON(content))
}

func takeover(root map[string]any) []string {
	reasons := []string{}
	for _, in := range inboundsOf(root) {
		switch in.typ {
		case C.TypeTun:
			reasons = append(reasons, "入站 "+in.tag+" 是 TUN：会创建虚拟网卡并接管系统路由")
		case C.TypeRedirect, C.TypeTProxy:
			reasons = append(reasons, "入站 "+in.tag+" 是透明代理："+in.typ)
		}
		if in.systemProxy {
			reasons = append(reasons, "入站 "+in.tag+" 开启了 set_system_proxy：会改写 macOS 系统代理，停止时直接关闭系统代理")
		}
	}
	for _, section := range []string{"endpoints", "services"} {
		items, _ := root[section].([]any)
		for _, it := range items {
			obj, _ := it.(map[string]any)
			tag, _ := obj["tag"].(string)
			typ, _ := obj["type"].(string)
			if system, _ := obj["system"].(bool); system {
				reasons = append(reasons, section+" "+tag+"（"+typ+"）开启了 system：会创建系统网卡")
			}
			if system, _ := obj["system_interface"].(bool); system {
				reasons = append(reasons, section+" "+tag+"（"+typ+"）开启了 system_interface：会创建系统网卡")
			}
			if typ == C.TypeBridge {
				reasons = append(reasons, section+" "+tag+" 是 bridge：会修改防火墙（pf）规则")
			}
		}
	}
	if ntp, _ := root["ntp"].(map[string]any); ntp["enabled"] == true && ntp["write_to_system"] == true {
		reasons = append(reasons, "时间同步开启了 write_to_system：会改写系统时间")
	}
	return reasons
}

// Start runs the active profile. Nothing else starts the core: the page
// calls it only from what the user does.
func (b *Box) Start() error {
	b.ops.Lock()
	defer b.ops.Unlock()
	return b.startLocked()
}

func (b *Box) startLocked() error {
	name := b.store.settings().Active
	if name == "" {
		return errors.New("还没有选择配置")
	}
	content, err := b.store.read(name)
	if err != nil {
		return fmt.Errorf("读取配置“%s”失败：%w", name, err)
	}
	if err := b.core.Start(name, content); err != nil {
		return err
	}
	b.note(log.LevelInfo, "已启动配置“%s”", name)
	for _, w := range b.core.Warnings() {
		b.note(log.LevelWarn, "配置用了废弃的写法：%s", w.Message)
	}
	if b.store.settings().SystemProxy {
		if err := b.applyProxyLocked(); err != nil {
			return fmt.Errorf("内核已启动，但没能设置系统代理：%w", err)
		}
	}
	return nil
}

// Stop stops the core, after putting the system proxy back.
func (b *Box) Stop() error {
	b.ops.Lock()
	defer b.ops.Unlock()
	return b.stopLocked()
}

func (b *Box) stopLocked() error {
	proxyErr := b.disableProxyLocked()
	b.proxyError = ""
	err := b.core.Stop()
	b.changed()
	return errors.Join(err, proxyErr)
}

// Reload runs the active profile anew: the profile saved, switched or
// updated takes effect. The node chosen and the mode come back from the
// cache file, as sing-box keeps them.
func (b *Box) Reload() error {
	b.ops.Lock()
	defer b.ops.Unlock()
	if b.core.Status() != statusRunning {
		return errNotRunning
	}
	b.note(log.LevelInfo, "重新载入配置“%s”", b.core.Profile())
	if err := b.stopLocked(); err != nil {
		return err
	}
	return b.startLocked()
}

// shutdown stops everything as the app quits.
func (b *Box) shutdown() {
	b.ops.Lock()
	defer b.ops.Unlock()
	b.disableProxyLocked()
	b.core.Shutdown()
}

// SetSystemProxy turns the system proxy setting on or off, and applies it
// at once while sing-box runs.
func (b *Box) SetSystemProxy(on bool) error {
	b.ops.Lock()
	defer b.ops.Unlock()
	b.store.update(func(s *settings) { s.SystemProxy = on })
	defer b.changed()
	if !on {
		b.proxyError = ""
		return b.disableProxyLocked()
	}
	if b.core.Status() != statusRunning {
		return nil
	}
	return b.applyProxyLocked()
}

// applyProxyLocked points the system proxy at the first HTTP-capable
// inbound of the configuration running.
func (b *Box) applyProxyLocked() error {
	var target *inbound
	for _, in := range inboundsOf(configJSON(b.core.Content())) {
		if (in.typ == C.TypeMixed || in.typ == C.TypeHTTP) && in.port > 0 {
			target = &in
			break
		}
	}
	if target == nil {
		b.proxyError = "配置里没有 mixed 或 http 入站，无法设置系统代理"
		b.note(log.LevelError, "%s", b.proxyError)
		return errors.New(b.proxyError)
	}
	host := target.listen
	if addr, err := netip.ParseAddr(host); host == "" || (err == nil && addr.IsUnspecified()) {
		host = "127.0.0.1"
	}
	if err := b.proxy.enable(host, target.port, target.typ == C.TypeMixed); err != nil {
		b.proxyError = err.Error()
		b.note(log.LevelError, "没能设置系统代理：%v", err)
		return err
	}
	b.proxyError = ""
	b.note(log.LevelInfo, "系统代理已指向 %s", net.JoinHostPort(host, strconv.Itoa(target.port)))
	return nil
}

// disableProxyLocked puts the system proxy back as it was, when the app
// had set it.
func (b *Box) disableProxyLocked() error {
	was, _ := b.proxy.active()
	err := b.proxy.disable()
	switch {
	case err != nil:
		b.note(log.LevelError, "没能恢复系统代理：%v", err)
	case was:
		b.note(log.LevelInfo, "系统代理已恢复为原来的设置")
	}
	return err
}

// CurrentSystemProxy describes the system's HTTP proxy now, as set by
// whichever app.
func (b *Box) CurrentSystemProxy() string { return currentProxy() }

// Groups returns the outbound groups of the running core.
func (b *Box) Groups() []OutboundGroup {
	groups := b.core.Groups()
	if groups == nil {
		return []OutboundGroup{}
	}
	return groups
}

// Select chooses an outbound of a selector.
func (b *Box) Select(group, tag string) error {
	err := b.core.SelectOutbound(group, tag)
	b.changed()
	return err
}

// URLTest measures the delays of a group's outbounds through the core,
// and returns once done.
func (b *Box) URLTest(group string) {
	b.core.URLTest(group)
	b.changed()
}

// TestOutbound measures the delay of one outbound through the core.
func (b *Box) TestOutbound(tag string) (int, error) {
	return b.core.TestOutbound(tag)
}

// SetMode switches the Clash mode: Rule, Global, Direct, or a mode the
// configuration's rules name.
func (b *Box) SetMode(mode string) error {
	return b.core.SetMode(mode)
}

// Connections returns the connections the core routed, newest first:
// those open, or those closed.
func (b *Box) Connections(closed bool) []Connection {
	return b.core.Connections(closed)
}

// CloseConnection closes a connection.
func (b *Box) CloseConnection(id string) { b.core.CloseConnection(id) }

// CloseAllConnections closes every connection.
func (b *Box) CloseAllConnections() { b.core.CloseAllConnections() }

// ClearClosedConnections forgets the connections closed.
func (b *Box) ClearClosedConnections() { b.core.ClearClosedConnections() }

// Activity returns the core's own network work that is not a routed
// connection, of a kind ("" for all), oldest first.
func (b *Box) Activity(kind ActivityKind, query string) []Activity {
	return b.core.Logs().activity.list(kind, query, 1500)
}

// ClearActivity empties the activity.
func (b *Box) ClearActivity() {
	b.core.Logs().activity.clear()
	b.logged()
}

// Rules returns the router's rules of the running core.
func (b *Box) Rules() []RuleInfo {
	rules := b.core.Rules()
	if rules == nil {
		return []RuleInfo{}
	}
	return rules
}

// ClearDNSCache empties the DNS cache of the running core.
func (b *Box) ClearDNSCache() { b.core.ClearDNSCache() }

// ResetFakeIP forgets the fake IP addresses given out.
func (b *Box) ResetFakeIP() error { return b.core.ResetFakeIP() }

// QueryDNS looks a name up through the running core's DNS, as its DNS
// rules route it: the query goes out for real, as the user asked.
func (b *Box) QueryDNS(name, qtype string) (DNSResult, error) {
	return b.core.QueryDNS(name, qtype)
}

// Logs returns the last lines of the log, at most limit, at or above a
// level ("error", "warn", "info", "debug" or "all"), of a source ("core",
// "app", or "" for both), that contain query.
func (b *Box) Logs(level, source, query string, limit int) []LogLine {
	lvl := log.LevelInfo
	switch level {
	case "error":
		lvl = log.LevelError
	case "warn":
		lvl = log.LevelWarn
	case "debug":
		lvl = log.LevelDebug
	case "all":
		lvl = log.LevelTrace
	}
	entries, _ := b.core.Logs().snapshot(lvl, source, query)
	if limit > 0 && len(entries) > limit {
		entries = entries[len(entries)-limit:]
	}
	lines := make([]LogLine, len(entries))
	for i, e := range entries {
		lines[i] = LogLine{Time: e.Time.Truncate(time.Millisecond), Level: log.FormatLevel(e.Level), Source: e.Source, Message: e.Message}
	}
	return lines
}

// DNSRecords returns the DNS queries the core answered, newest first,
// that contain query, at most limit.
func (b *Box) DNSRecords(query string, limit int) []DNSRecord {
	if limit <= 0 {
		limit = dnsRecordLimit
	}
	return b.core.Logs().dns.list(query, limit)
}

// ClearDNSRecords forgets the DNS queries recorded.
func (b *Box) ClearDNSRecords() {
	b.core.Logs().dns.clear()
	b.logged()
}

// ConnectionLogs returns the core's lines of one connection, by the ID
// they carry, at every level, oldest first.
func (b *Box) ConnectionLogs(logID uint32) []LogLine {
	entries := b.core.Logs().conns.get(logID)
	lines := make([]LogLine, len(entries))
	for i, e := range entries {
		lines[i] = LogLine{Time: e.Time.Truncate(time.Millisecond), Level: log.FormatLevel(e.Level), Source: e.Source, Message: e.Message}
	}
	return lines
}

// ProcessIcon returns the icon of the app a program's path is in, as a
// data URL of a PNG, or "" for a program without one.
func (b *Box) ProcessIcon(path string) string { return b.icons.icon(path) }

// ClearLogs empties the log.
func (b *Box) ClearLogs() {
	b.core.Logs().clear()
	b.logged()
}

// ExportLogs asks where to save the log, and saves it there.
func (b *Box) ExportLogs(ctx context.Context, level, source, query string) (string, error) {
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent:      mygo.CallerWindow(ctx),
		Title:       "导出日志",
		DefaultPath: "boxcar-" + time.Now().Format("20060102-150405") + ".log",
	})
	if err != nil || path == "" {
		return "", err
	}
	lines := b.Logs(level, source, query, 0)
	var buf bytes.Buffer
	for _, l := range lines {
		from := "core"
		if l.Source == sourceApp {
			from = "app "
		}
		fmt.Fprintf(&buf, "%s %s %s %s\n", l.Time.Format("2006-01-02 15:04:05.000"), from, strings.ToUpper(l.Level), l.Message)
	}
	return path, os.WriteFile(path, buf.Bytes(), 0o644)
}

// Profiles lists the configuration files.
func (b *Box) Profiles() Profiles {
	list, _ := b.store.profiles()
	set := b.store.settings()
	out := Profiles{Active: set.Active, Items: []Profile{}}
	for _, p := range list {
		out.Items = append(out.Items, Profile{
			Name: p.Name, Path: p.Path, Size: p.Size, Modified: p.ModTime.Truncate(time.Millisecond),
			Remote: set.Remote[p.Name], Origin: set.Origins[p.Name], Edited: b.store.edited(p.Name),
		})
	}
	if b.core.Status() == statusRunning {
		out.Running = b.core.Profile()
		// Renamed or removed since, it has no saved version to differ from.
		if current, err := b.store.read(out.Running); err == nil {
			running := b.core.Content()
			out.RunningStale = running != nil && !sameConfig(current, running)
		}
	}
	return out
}

// ReadSource returns the text of what a profile was imported, downloaded
// or created as.
func (b *Box) ReadSource(name string) (string, error) {
	content, err := b.store.source(name)
	if errors.Is(err, os.ErrNotExist) {
		return "", errNoSource
	}
	return string(content), err
}

// RunningProfile returns the text of the configuration the core runs, as
// it was read when started: saves since then are not in it.
func (b *Box) RunningProfile() (string, error) {
	if b.core.Status() != statusRunning {
		return "", errNotRunning
	}
	return string(b.core.Content()), nil
}

// ReadProfile returns the text of a profile.
func (b *Box) ReadProfile(name string) (string, error) {
	content, err := b.store.read(name)
	return string(content), err
}

// SaveProfile writes the text of a profile.
func (b *Box) SaveProfile(name, content string) error {
	b.writes.Lock()
	err := b.store.write(name, []byte(content))
	b.writes.Unlock()
	if err != nil {
		b.note(log.LevelError, "保存配置“%s”失败：%v", name, err)
	} else {
		b.store.markSaved(name)
		// The conflicts of the last update are the user's to settle: a save
		// settles them.
		if r := b.store.settings().Remote[name]; r != nil && len(r.Conflicts) > 0 {
			r.Conflicts = nil
			b.store.setRemote(name, r)
		}
		b.note(log.LevelInfo, "已保存配置“%s”", name)
	}
	b.changed()
	return err
}

// CheckProfile checks a configuration as `sing-box check` does: it builds
// an instance and closes it without starting it. It also checks what the
// core checks only once started: that every tag referred to exists.
func (b *Box) CheckProfile(content string) CheckResult {
	warnings, err := checkConfig([]byte(content))
	if warnings == nil {
		warnings = []Warning{}
	}
	problems := checkReferences(rawJSON([]byte(content)))
	if problems == nil {
		problems = []Problem{}
	}
	r := CheckResult{OK: true, Warnings: warnings, Problems: problems}
	fatal := 0
	for _, p := range problems {
		if p.Fatal {
			fatal++
		}
	}
	switch {
	case err != nil:
		r.OK, r.Error = false, err.Error()
	case fatal > 0:
		r.OK, r.Error = false, fmt.Sprintf("有 %d 处引用不存在或标签重复，启动时会失败", fatal)
	}
	return r
}

// FormatProfile returns a configuration as sing-box reads it, indented.
// Comments are not kept.
func (b *Box) FormatProfile(content string) (string, error) {
	options, err := parseOptions([]byte(content))
	if err != nil {
		return "", err
	}
	canonical, err := json.MarshalContext(baseContext(), options)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := stdjson.Indent(&buf, canonical, "", "  "); err != nil {
		return "", err
	}
	return buf.String() + "\n", nil
}

// NewProfile creates a profile from the sample and returns its name.
func (b *Box) NewProfile() (string, error) {
	name, err := b.store.create("新配置", []byte(sampleProfile))
	if err == nil {
		err = b.store.setSource(name, []byte(sampleProfile), originNew, "")
	}
	if err == nil {
		b.note(log.LevelInfo, "新建配置“%s”", name)
	}
	return name, err
}

// ImportProfiles asks for configuration files and copies them in.
func (b *Box) ImportProfiles(ctx context.Context) (ImportResult, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:   mygo.CallerWindow(ctx),
		Title:    "导入 sing-box 配置",
		Filters:  []mygo.FileFilter{{Name: "JSON", Extensions: []string{"json", "jsonc"}}},
		Multiple: true,
	})
	if err != nil {
		return ImportResult{Names: []string{}, Failed: []string{}}, err
	}
	return b.ImportFiles(paths), nil
}

// ImportFiles copies configuration files in, as dropped on the window.
func (b *Box) ImportFiles(paths []string) ImportResult {
	r := ImportResult{Names: []string{}, Failed: []string{}}
	for _, path := range paths {
		name, err := b.store.importFile(path)
		if err != nil {
			r.Failed = append(r.Failed, path+"："+err.Error())
			b.note(log.LevelError, "导入 %s 失败：%v", abbreviateHome(path), err)
			continue
		}
		r.Names = append(r.Names, name)
		b.note(log.LevelInfo, "从 %s 导入配置“%s”", abbreviateHome(path), name)
	}
	if b.store.settings().Active == "" && len(r.Names) > 0 {
		b.SetActive(r.Names[0])
	}
	return r
}

// AddRemoteProfile downloads a subscription and keeps it as a profile,
// updated every interval minutes while autoUpdate.
func (b *Box) AddRemoteProfile(name, link string, autoUpdate bool, interval int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	content, err := fetchProfile(ctx, link)
	if err == nil {
		if _, checkErr := checkConfig(content); checkErr != nil {
			err = fmt.Errorf("下载的内容不是可用的 sing-box 配置：%w", checkErr)
		}
	}
	if err != nil {
		b.note(log.LevelError, "添加订阅失败：%v", err)
		return "", err
	}
	if strings.TrimSpace(name) == "" {
		name = "订阅"
	}
	created, err := b.store.create(name, content)
	if err == nil {
		err = b.store.setSource(created, content, originSubscription, "")
	}
	if err != nil {
		return "", err
	}
	b.store.setRemote(created, &Remote{URL: strings.TrimSpace(link), AutoUpdate: autoUpdate, Interval: interval, UpdatedAt: time.Now().Truncate(time.Second)})
	b.note(log.LevelInfo, "已添加订阅“%s”", created)
	if b.store.settings().Active == "" {
		b.SetActive(created)
	}
	return created, nil
}

// SetRemote changes where a subscription comes from and how often it
// updates.
func (b *Box) SetRemote(name string, r Remote) error {
	current := b.store.settings().Remote[name]
	if current == nil {
		return errors.New("“" + name + "”不是订阅")
	}
	r.UpdatedAt, r.Error = current.UpdatedAt, current.Error
	if strings.TrimSpace(r.URL) == "" {
		return errors.New("订阅地址不能为空")
	}
	r.URL = strings.TrimSpace(r.URL)
	b.store.setRemote(name, &r)
	return nil
}

// UpdateProfile downloads a subscription anew. A configuration that does
// not check out is not kept. The profile running reloads.
func (b *Box) UpdateProfile(name string) error {
	b.updatingMu.Lock()
	if b.updating[name] {
		b.updatingMu.Unlock()
		return errors.New("“" + name + "”正在更新")
	}
	b.updating[name] = true
	b.updatingMu.Unlock()
	defer func() {
		b.updatingMu.Lock()
		delete(b.updating, name)
		b.updatingMu.Unlock()
	}()

	r := b.store.settings().Remote[name]
	if r == nil {
		return errors.New("“" + name + "”不是订阅")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	content, err := fetchProfile(ctx, r.URL)
	if err == nil {
		if _, checkErr := checkConfig(content); checkErr != nil {
			err = fmt.Errorf("下载的内容不是可用的 sing-box 配置，已保留原配置：%w", checkErr)
		}
	}
	if err != nil {
		r.Error = err.Error()
		b.store.setRemote(name, r)
		b.profilesChanged()
		b.note(log.LevelWarn, "更新订阅“%s”失败：%v", name, err)
		return err
	}
	b.writes.Lock()
	old, _ := b.store.read(name)
	updated, conflicts, err := b.mergeUpdate(name, old, content)
	if err == nil {
		err = b.store.write(name, updated)
	}
	b.writes.Unlock()
	if err != nil {
		r.Error = err.Error()
		b.store.setRemote(name, r)
		b.profilesChanged()
		b.note(log.LevelWarn, "更新订阅“%s”失败：%v", name, err)
		return err
	}
	if err := b.store.setSource(name, content, originSubscription, ""); err != nil {
		// The next update merges from the source before: mostly the same.
		b.note(log.LevelWarn, "没能保存订阅“%s”下载的内容作为来源：%v", name, err)
	}
	r.UpdatedAt, r.Error, r.Conflicts = time.Now().Truncate(time.Second), "", conflicts
	b.store.setRemote(name, r)
	b.profilesChanged()
	switch {
	case bytes.Equal(old, updated):
		b.note(log.LevelInfo, "订阅“%s”已是最新", name)
	case len(conflicts) > 0:
		b.note(log.LevelWarn, "订阅“%s”已更新，本机修改与更新冲突的 %d 处保留了本机修改：%s", name, len(conflicts), strings.Join(conflicts, "、"))
	default:
		b.note(log.LevelInfo, "订阅“%s”已更新", name)
	}
	content = updated
	if !bytes.Equal(old, content) && b.core.Status() == statusRunning && b.core.Profile() == name && b.store.settings().Active == name {
		return b.Reload()
	}
	return nil
}

// mergeUpdate is the profile a subscription download makes: the download
// itself, unless the user changed the profile since the last one, when
// both changes merge. The result must check out, or the profile stays.
func (b *Box) mergeUpdate(name string, current, download []byte) ([]byte, []string, error) {
	base, err := b.store.source(name)
	switch {
	case errors.Is(err, os.ErrNotExist):
		// Nothing to tell edits by: the download, as before sources.
		b.note(log.LevelWarn, "订阅“%s”没有保存的来源，更新整份替换了配置", name)
		return download, nil, nil
	case err != nil:
		return nil, nil, fmt.Errorf("读取订阅的来源失败，已保留原配置：%w", err)
	case sameConfig(current, base):
		return download, nil, nil
	}
	merged, conflicts, err := mergeConfig(base, download, current)
	if err != nil {
		return nil, nil, fmt.Errorf("没能把本机修改合并进更新，已保留原配置：%w", err)
	}
	if _, err := checkConfig(merged); err != nil {
		return nil, nil, fmt.Errorf("本机修改合并进更新后校验不通过，已保留原配置。可能是本机修改与更新冲突（例如删掉的节点被新规则引用），可以「对比来源」后处理：%w", err)
	}
	return merged, conflicts, nil
}

// updateDue updates the subscriptions whose time has come.
func (b *Box) updateDue() {
	b.updateMu.Lock()
	defer b.updateMu.Unlock()
	for name, r := range b.store.settings().Remote {
		if !r.AutoUpdate {
			continue
		}
		normalizeRemote(r)
		if time.Since(r.UpdatedAt) < time.Duration(r.Interval)*time.Minute {
			continue
		}
		// UpdateProfile logs how it went.
		b.UpdateProfile(name)
	}
}

// updateLoop updates the subscriptions as they come due.
func (b *Box) updateLoop() {
	for {
		b.updateDue()
		time.Sleep(time.Minute)
	}
}

func (b *Box) profilesChanged() {
	b.updatingMu.Lock()
	b.profilesV++
	v := b.profilesV
	b.updatingMu.Unlock()
	ProfilesChanged.Broadcast(v)
}

// RenameProfile renames a profile.
func (b *Box) RenameProfile(from, to string) error {
	err := b.store.rename(from, strings.TrimSpace(to))
	if err == nil {
		b.note(log.LevelInfo, "配置“%s”改名为“%s”", from, strings.TrimSpace(to))
	}
	b.changed()
	return err
}

// DeleteProfile moves a profile to the Trash.
func (b *Box) DeleteProfile(name string) error {
	err := b.store.remove(name)
	if err == nil {
		b.note(log.LevelInfo, "配置“%s”已移到废纸篓", name)
	}
	b.changed()
	return err
}

// SetActive chooses the profile Start runs.
func (b *Box) SetActive(name string) {
	b.store.update(func(s *settings) { s.Active = name })
	b.changed()
}

// RevealProfile shows a profile in Finder.
func (b *Box) RevealProfile(name string) { mygo.Shell.ShowItemInFolder(b.store.path(name)) }

// OpenDataDir opens the data directory in Finder.
func (b *Box) OpenDataDir() { mygo.Shell.OpenPath(b.store.dir) }

// Theme returns the appearance chosen.
func (b *Box) Theme() Theme {
	switch t := Theme(b.store.settings().Theme); t {
	case ThemeLight, ThemeDark:
		return t
	}
	return ThemeSystem
}

// SetTheme changes the appearance.
func (b *Box) SetTheme(theme Theme) {
	b.store.update(func(s *settings) { s.Theme = string(theme) })
	applyTheme(string(theme))
}

// LoginItem reports whether the app opens at login. Opening the app
// never starts sing-box.
func (b *Box) LoginItem() bool { return mygo.App.OpenAtLogin() }

// SetLoginItem opens the app at login, or not.
func (b *Box) SetLoginItem(open bool) error { return mygo.App.SetOpenAtLogin(open) }

// About describes the build.
func (b *Box) About() About {
	a := About{App: appVersion(), Version: C.Version, Go: runtime.Version(), Platform: runtime.GOOS + "/" + runtime.GOARCH, MyGo: mygo.Version, Tags: []string{}, DataDir: abbreviateHome(b.store.dir)}
	tags, cgo := buildTags()
	for _, tag := range tags {
		if v, ok := strings.CutPrefix(tag, "with_"); ok {
			a.Tags = append(a.Tags, v)
		}
	}
	a.Missing = missingTypes(tags, cgo)
	return a
}

func appVersion() string { return mygo.App.Version() }

// applyTheme follows the appearance chosen.
func applyTheme(theme string) {
	switch theme {
	case "light":
		mygo.Theme.SetSource(mygo.ThemeLight)
	case "dark":
		mygo.Theme.SetSource(mygo.ThemeDark)
	default:
		mygo.Theme.SetSource(mygo.ThemeSystem)
	}
}
