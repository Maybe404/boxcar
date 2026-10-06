package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/trafficcontrol"
	"github.com/sagernet/sing-box/common/urltest"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/experimental/clashmode"
	"github.com/sagernet/sing-box/experimental/deprecated"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/group"
	"github.com/sagernet/sing/common"
	"github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/common/memory"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/common/observable"
	"github.com/sagernet/sing/service"

	"github.com/gofrs/uuid/v5"
	mDNS "github.com/miekg/dns"
)

// coreStatus is where the embedded sing-box instance is in its life.
type coreStatus int

const (
	statusStopped coreStatus = iota
	statusStarting
	statusRunning
	statusStopping
)

// baseContext is the context every instance derives from: the registries
// of every protocol the build includes.
var baseContext = sync.OnceValue(func() context.Context {
	return include.Context(service.ContextWith(context.Background(), deprecated.NewStderrManager(log.StdLogger())))
})

// parseOptions decodes a configuration, as `sing-box check` does.
func parseOptions(content []byte) (option.Options, error) {
	return parseOptionsIn(baseContext(), content)
}

func parseOptionsIn(ctx context.Context, content []byte) (option.Options, error) {
	return json.UnmarshalExtendedContext[option.Options](ctx, content)
}

// Warning is a deprecated part of a configuration, as sing-box reports it.
type Warning struct {
	Message   string `json:"message"`
	Link      string `json:"link,omitempty"`
	Impending bool   `json:"impending"`
}

// notes collects what sing-box reports deprecated while it decodes and
// builds a configuration, which it would otherwise write to stderr.
type notes struct {
	mu   sync.Mutex
	list []Warning
}

func (n *notes) ReportDeprecated(note deprecated.Note) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, w := range n.list {
		if w.Message == note.Message() {
			return
		}
	}
	n.list = append(n.list, Warning{Message: note.Message(), Link: note.MigrationLink, Impending: note.Impending()})
}

func (n *notes) warnings() []Warning {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.Clone(n.list)
}

// noteContext is a context of its own for an instance, whose deprecated
// parts go to n.
func noteContext(n *notes) context.Context {
	ctx := service.ExtendContext(baseContext())
	service.MustRegister[deprecated.Manager](ctx, n)
	return ctx
}

// checkConfig decodes a configuration and builds an instance from it
// without starting it, which is what `sing-box check` does: nothing
// listens, no route or interface changes. It returns what is deprecated.
func checkConfig(content []byte) ([]Warning, error) {
	n := &notes{}
	ctx, cancel := context.WithCancel(noteContext(n))
	defer cancel()
	options, err := parseOptionsIn(ctx, content)
	if err != nil {
		return nil, err
	}
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		return n.warnings(), err
	}
	return n.warnings(), instance.Close()
}

// GroupItem is an outbound of a group.
type GroupItem struct {
	Tag   string `json:"tag"`
	Type  string `json:"type"`
	Delay int    `json:"delay"` // in milliseconds, 0 when untested
	// TestedAt is when the delay was measured.
	TestedAt time.Time `json:"testedAt,omitzero"`
}

// OutboundGroup is a group of outbounds, as a selector or a urltest.
type OutboundGroup struct {
	Tag        string      `json:"tag"`
	Type       string      `json:"type"`
	Selected   string      `json:"selected"`
	Selectable bool        `json:"selectable"`
	Items      []GroupItem `json:"items"`
}

// Connection is a connection the core routed.
type Connection struct {
	ID string `json:"id"`
	// Seq numbers the connections in the order they came, from 1 for
	// each run.
	Seq int64 `json:"seq"`
	// LogID is the ID of the connection in the core's log lines: the
	// number in "[1234567 12ms]"; zero when unknown.
	LogID       uint32 `json:"logId,omitempty"`
	Inbound     string `json:"inbound"`
	InboundType string `json:"inboundType"`
	Network     string `json:"network"`
	IPVersion   int    `json:"ipVersion,omitempty"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Domain      string `json:"domain"`
	Protocol    string `json:"protocol,omitempty"`
	// Client is the client the sniffer recognised, as chromium.
	Client string `json:"client,omitempty"`
	// Addresses are the IP addresses the domain resolved to, when the
	// core resolved it.
	Addresses []string `json:"addresses"`
	// OriginDestination is where the connection went first, when a rule
	// sent it elsewhere.
	OriginDestination string `json:"originDestination,omitempty"`
	// FakeIP is set when the destination was a fake IP address.
	FakeIP      bool   `json:"fakeIp,omitempty"`
	User        string `json:"user,omitempty"`
	Process     string `json:"process,omitempty"`
	ProcessPath string `json:"processPath,omitempty"`
	ProcessID   int    `json:"processId,omitempty"`
	// ViaPath is the process that opened the socket for the app
	// ProcessPath names, as a system service does for it.
	ViaPath      string   `json:"viaPath,omitempty"`
	Rule         string   `json:"rule"`
	Outbound     string   `json:"outbound"`
	OutboundType string   `json:"outboundType"`
	Chain        []string `json:"chain"`
	Upload       int64    `json:"upload"`
	Download     int64    `json:"download"`
	// The rates of the last second, while open: bytes per second.
	UploadRate   int64     `json:"uploadRate"`
	DownloadRate int64     `json:"downloadRate"`
	CreatedAt    time.Time `json:"createdAt"`
	// ClosedAt is when the connection closed; zero while open.
	ClosedAt time.Time `json:"closedAt,omitzero"`
}

// DNSResult is the answer of a DNS query through the core.
type DNSResult struct {
	// Rcode is the response code, as NOERROR or NXDOMAIN.
	Rcode   string      `json:"rcode"`
	Answers []DNSAnswer `json:"answers"`
	// Took is how long the query took, in milliseconds; a cached answer
	// takes about none.
	Took int `json:"took"`
}

// DNSAnswer is a record of an answer.
type DNSAnswer struct {
	Name string `json:"name"`
	Type string `json:"type"`
	TTL  uint32 `json:"ttl"`
	Data string `json:"data"`
}

// Stats are the figures of a running instance.
type Stats struct {
	Upload       int64 `json:"upload"`       // bytes in total
	Download     int64 `json:"download"`     // bytes in total
	UploadRate   int64 `json:"uploadRate"`   // bytes per second
	DownloadRate int64 `json:"downloadRate"` // bytes per second
	// Connections are the routed connections open.
	Connections int `json:"connections"`
	// OutboundConnections are the connections the core holds to outbounds.
	OutboundConnections int     `json:"outboundConnections"`
	Memory              uint64  `json:"memory"`
	Goroutines          int     `json:"goroutines"`
	UploadHistory       []int64 `json:"uploadHistory"` // the rates of the last minute
	DownHistory         []int64 `json:"downHistory"`
}

// ModeState is the Clash mode of the core: Rule, Global, Direct, or the
// modes the configuration's rules name.
type ModeState struct {
	Current string   `json:"current"`
	List    []string `json:"list"`
}

// RuleInfo is a rule of the router.
type RuleInfo struct {
	Index  int    `json:"index"`
	Type   string `json:"type"`
	Rule   string `json:"rule"`
	Action string `json:"action"`
}

// Core is what the interface asks of the embedded sing-box, so that the
// service can be tested against a fake one.
type Core interface {
	Status() coreStatus
	Profile() string
	StartedAt() time.Time
	LastError() error
	// Start creates and starts an instance; only the user starts it.
	Start(profile string, content []byte) error
	Stop() error
	// Shutdown leaves the core stopped, whatever it is doing.
	Shutdown()
	// Content is the configuration running, nil while stopped.
	Content() []byte
	Stats() Stats
	Groups() []OutboundGroup
	// Chain is the outbounds the default route goes through: its groups,
	// then the outbound they choose. Empty while stopped.
	Chain() []string
	SelectOutbound(group, tag string) error
	// URLTest measures the delays of a group's outbounds, and returns once
	// done.
	URLTest(group string)
	// TestOutbound measures the delay of one outbound, in milliseconds.
	TestOutbound(tag string) (int, error)
	Mode() ModeState
	SetMode(mode string) error
	Connections(closed bool) []Connection
	CloseConnection(id string)
	CloseAllConnections()
	ClearClosedConnections()
	Warnings() []Warning
	Rules() []RuleInfo
	ClearDNSCache()
	ResetFakeIP() error
	// QueryDNS asks the running core's DNS, as its rules route the name.
	QueryDNS(name, qtype string) (DNSResult, error)
	// LogLevel is the level the running configuration logs at.
	LogLevel() string
	Logs() *logBuffer
}

// boxCore runs sing-box in this process.
type boxCore struct {
	mu        sync.Mutex
	status    coreStatus
	profile   string
	startedAt time.Time
	err       error

	ctx      context.Context
	cancel   context.CancelFunc
	instance *box.Box
	traffic  *trafficcontrol.Manager
	history  *urltest.HistoryStorage
	outbound adapter.OutboundManager
	conns    adapter.ConnectionManager
	mode     *clashmode.Manager
	notes    *notes
	logLevel log.Level
	// logDisabled is set when the configuration turns the log off.
	logDisabled bool
	// testHook carries the URL tests' results to the page.
	testHook *observable.Subscriber[struct{}]

	logs     *logBuffer
	tracked  *connHistory
	onChange func()

	// content is the configuration running, or starting.
	content []byte
	// startCancel aborts a start in progress; idle is closed once no
	// start or stop is in progress.
	startCancel context.CancelFunc
	idle        chan struct{}

	// The rates, sampled every second while running.
	sampleStop chan struct{}
	sampled    bool
	stats      Stats
}

func newBoxCore(onChange func()) *boxCore {
	idle := make(chan struct{})
	close(idle)
	return &boxCore{logs: newLogBuffer(5000), tracked: newConnHistory(), onChange: onChange, idle: idle}
}

func (c *boxCore) changed() {
	if c.onChange != nil {
		c.onChange()
	}
}

func (c *boxCore) Status() coreStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

func (c *boxCore) Profile() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.profile
}

func (c *boxCore) StartedAt() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.startedAt
}

func (c *boxCore) LastError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *boxCore) Logs() *logBuffer { return c.logs }

// Content returns the configuration running, nil while stopped.
func (c *boxCore) Content() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.content
}

var (
	errBusy       = errors.New("内核正在启动或停止")
	errNotRunning = errors.New("内核未运行")
)

// Start creates and starts an instance of the configuration. It is only
// ever called from what the user does: nothing starts the core on its own.
func (c *boxCore) Start(profile string, content []byte) error {
	c.mu.Lock()
	if c.status != statusStopped {
		c.mu.Unlock()
		return errBusy
	}
	c.status, c.profile, c.err, c.content = statusStarting, profile, nil, content
	idle := make(chan struct{})
	c.idle = idle
	c.mu.Unlock()
	c.changed()

	err := c.start(content)
	c.mu.Lock()
	c.startCancel = nil
	if err != nil {
		c.status, c.err, c.content = statusStopped, err, nil
	} else {
		c.status, c.startedAt = statusRunning, time.Now()
		c.sampleStop, c.sampled = make(chan struct{}), false
		go c.sample(c.sampleStop)
	}
	close(idle)
	c.mu.Unlock()
	if err != nil {
		c.logs.add(log.LevelError, "启动失败："+err.Error())
	}
	c.changed()
	return err
}

func (c *boxCore) start(content []byte) error {
	n := &notes{}
	ctx, cancel := context.WithCancel(noteContext(n))
	c.mu.Lock()
	c.startCancel, c.notes = cancel, n
	c.mu.Unlock()
	options, err := parseOptionsIn(ctx, content)
	if err != nil {
		cancel()
		return err
	}
	level := configLogLevel(options)
	c.logs.setLevel(level)
	logDisabled := options.Log != nil && options.Log.Disabled
	history := urltest.NewHistoryStorage()
	ctx = service.ContextWithPtr(ctx, history)
	instance, err := box.New(box.Options{Context: ctx, Options: options, PlatformLogWriter: c.logs})
	if err != nil {
		cancel()
		return err
	}
	// After the traffic manager, which box.New appends, so that each
	// connection reaches the history with its metadata; before Start, as
	// the router does not guard its trackers.
	c.tracked = newConnHistory()
	instance.Router().AppendTracker(c.tracked)
	// The delays reach the page as soon as they are measured.
	hook := notifyOn(c.changed)
	history.AddUpdateHook(hook)
	if err := instance.Start(); err != nil {
		instance.Close()
		cancel()
		history.Close()
		hook.Close()
		return err
	}
	c.mu.Lock()
	c.ctx, c.cancel, c.instance, c.history, c.logLevel, c.testHook = ctx, cancel, instance, history, level, hook
	c.logDisabled = logDisabled
	c.traffic = service.PtrFromContext[trafficcontrol.Manager](ctx)
	c.outbound = service.FromContext[adapter.OutboundManager](ctx)
	c.conns = service.FromContext[adapter.ConnectionManager](ctx)
	c.mode = service.PtrFromContext[clashmode.Manager](ctx)
	c.stats = Stats{}
	c.mu.Unlock()
	return nil
}

// configLogLevel is the level a configuration logs at, as sing-box
// reads it; the platform writer receives every level regardless.
func configLogLevel(options option.Options) log.Level {
	if options.Log != nil && options.Log.Level != "" {
		if level, err := log.ParseLevel(options.Log.Level); err == nil {
			return level
		}
	}
	return log.LevelInfo
}

// Stop closes the instance.
func (c *boxCore) Stop() error {
	c.mu.Lock()
	if c.status != statusRunning {
		c.mu.Unlock()
		return errBusy
	}
	c.status = statusStopping
	instance, cancel, history, hook := c.instance, c.cancel, c.history, c.testHook
	close(c.sampleStop)
	idle := make(chan struct{})
	c.idle = idle
	c.mu.Unlock()
	c.changed()

	err := instance.Close()
	cancel()
	history.Close()
	hook.Close()
	c.tracked.closeAll(time.Now())
	runtime.GC()

	c.mu.Lock()
	c.status, c.instance, c.ctx, c.cancel, c.traffic, c.outbound, c.history = statusStopped, nil, nil, nil, nil, nil, nil
	c.conns, c.mode, c.testHook = nil, nil, nil
	c.stats, c.content = Stats{}, nil
	close(idle)
	c.mu.Unlock()
	c.logs.add(log.LevelInfo, "内核已停止")
	c.changed()
	return err
}

// Shutdown leaves the core stopped, as the app quits: it aborts a start in
// progress, waits for a stop in progress, and stops a running core, so that
// whatever the configuration changed in the system is undone.
func (c *boxCore) Shutdown() {
	c.mu.Lock()
	status, cancel, idle := c.status, c.startCancel, c.idle
	c.mu.Unlock()
	if status == statusStarting && cancel != nil {
		cancel()
	}
	<-idle
	if c.Status() == statusRunning {
		c.Stop()
	}
}

// sample measures the rates once a second, and notes the connections
// that closed.
func (c *boxCore) sample(stop chan struct{}) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-ticker.C:
			c.mu.Lock()
			s := c.stats
			traffic, conns := c.traffic, c.conns
			if traffic != nil {
				up, down := traffic.Total()
				if c.sampled {
					s.UploadRate, s.DownloadRate = max(up-s.Upload, 0), max(down-s.Download, 0)
				}
				c.sampled = true
				s.Upload, s.Download = up, down
				s.Connections = traffic.ConnectionsLen()
			}
			if conns != nil {
				s.OutboundConnections = conns.Count()
			}
			s.Memory = memory.Total()
			s.Goroutines = runtime.NumGoroutine()
			s.UploadHistory = pushRate(s.UploadHistory, s.UploadRate)
			s.DownHistory = pushRate(s.DownHistory, s.DownloadRate)
			c.stats = s
			c.mu.Unlock()
			if traffic != nil {
				c.tracked.reconcile(traffic, now)
			}
			c.changed()
		}
	}
}

// rateHistory is how many seconds of rates the stats keep.
const rateHistory = 60

func pushRate(h []int64, v int64) []int64 {
	h = append(slices.Clone(h), v)
	if len(h) > rateHistory {
		h = h[len(h)-rateHistory:]
	}
	return h
}

func (c *boxCore) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stats
}

func (c *boxCore) LogLevel() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.status != statusRunning {
		return ""
	}
	if c.logDisabled {
		// The core logs nothing at all, not even to the platform writer.
		return "disabled"
	}
	return log.FormatLevel(c.logLevel)
}

func (c *boxCore) Warnings() []Warning {
	c.mu.Lock()
	n := c.notes
	c.mu.Unlock()
	if n == nil {
		return nil
	}
	return n.warnings()
}

func (c *boxCore) Groups() []OutboundGroup {
	c.mu.Lock()
	manager, history := c.outbound, c.history
	c.mu.Unlock()
	if manager == nil {
		return nil
	}
	var groups []OutboundGroup
	for _, it := range manager.Outbounds() {
		iGroup, isGroup := it.(adapter.OutboundGroup)
		if !isGroup {
			continue
		}
		g := OutboundGroup{Tag: iGroup.Tag(), Type: iGroup.Type()}
		_, g.Selectable = iGroup.(*group.Selector)
		if selected := iGroup.Selected(N.NetworkTCP); selected != nil {
			g.Selected = selected.Tag()
		}
		for _, tag := range iGroup.All() {
			item, loaded := manager.Outbound(tag)
			if !loaded {
				continue
			}
			gi := GroupItem{Tag: tag, Type: item.Type()}
			if h := history.LoadURLTestHistory(group.RealTag(item, N.NetworkTCP)); h != nil {
				gi.Delay, gi.TestedAt = int(h.Delay), h.Time.Truncate(time.Millisecond)
			}
			g.Items = append(g.Items, gi)
		}
		if len(g.Items) > 0 {
			groups = append(groups, g)
		}
	}
	return groups
}

func (c *boxCore) Chain() []string {
	c.mu.Lock()
	manager := c.outbound
	c.mu.Unlock()
	if manager == nil {
		return nil
	}
	var chain []string
	it := manager.Default()
	for it != nil && len(chain) < 16 {
		chain = append(chain, it.Tag())
		g, isGroup := it.(adapter.OutboundGroup)
		if !isGroup {
			break
		}
		it = g.Selected(N.NetworkTCP)
	}
	return chain
}

func (c *boxCore) SelectOutbound(groupTag, tag string) error {
	c.mu.Lock()
	manager := c.outbound
	c.mu.Unlock()
	if manager == nil {
		return errNotRunning
	}
	it, loaded := manager.Outbound(groupTag)
	if !loaded {
		return errors.New("找不到策略组 " + groupTag)
	}
	selector, isSelector := it.(*group.Selector)
	if !isSelector {
		return errors.New(groupTag + " 不是可手动选择的策略组")
	}
	if !selector.SelectOutbound(tag) {
		return errors.New("策略组 " + groupTag + " 中没有 " + tag)
	}
	c.changed()
	return nil
}

// URLTest measures the delays of a group's outbounds through the core, as
// the official clients do, and returns once done.
func (c *boxCore) URLTest(groupTag string) {
	c.mu.Lock()
	ctx, manager, history, instance := c.ctx, c.outbound, c.history, c.instance
	c.mu.Unlock()
	if manager == nil {
		return
	}
	it, loaded := manager.Outbound(groupTag)
	if !loaded {
		return
	}
	if urlTest, isURLTest := it.(*group.URLTest); isURLTest {
		urlTest.CheckOutbounds()
		c.changed()
		return
	}
	iGroup, isGroup := it.(adapter.OutboundGroup)
	if !isGroup {
		return
	}
	outbounds := common.FilterNotNil(common.Map(iGroup.All(), func(tag string) adapter.Outbound {
		o, _ := manager.Outbound(tag)
		return o
	}))
	group.URLTestOutbounds(ctx, manager, history, instance.LogFactory().Logger(), outbounds, "", 0, true)
	c.changed()
}

// TestOutbound measures the delay of one outbound through the core, and
// lets the urltest groups choose again.
func (c *boxCore) TestOutbound(tag string) (int, error) {
	c.mu.Lock()
	ctx, manager, history := c.ctx, c.outbound, c.history
	c.mu.Unlock()
	if manager == nil {
		return 0, errNotRunning
	}
	it, loaded := manager.Outbound(tag)
	if !loaded {
		return 0, errors.New("找不到出站 " + tag)
	}
	real := group.RealTag(it, N.NetworkTCP)
	testCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	delay, err := urltest.URLTest(testCtx, "", it)
	if err != nil {
		history.DeleteURLTestHistory(real)
		c.changed()
		return 0, err
	}
	history.StoreURLTestHistory(real, &adapter.URLTestHistory{Time: time.Now(), Delay: delay})
	for _, o := range manager.Outbounds() {
		if g, ok := o.(adapter.URLTestGroup); ok {
			g.PerformUpdateCheck()
		}
	}
	c.changed()
	return int(delay), nil
}

func (c *boxCore) Mode() ModeState {
	c.mu.Lock()
	m := c.mode
	c.mu.Unlock()
	if m == nil {
		return ModeState{List: []string{}}
	}
	return ModeState{Current: m.Mode(), List: slices.Clone(m.ModeList())}
}

func (c *boxCore) SetMode(mode string) error {
	c.mu.Lock()
	m := c.mode
	c.mu.Unlock()
	if m == nil {
		return errNotRunning
	}
	if !slices.ContainsFunc(m.ModeList(), func(it string) bool { return equalFold(it, mode) }) {
		return errors.New("配置里没有模式 " + mode)
	}
	m.SetMode(mode)
	c.changed()
	return nil
}

func (c *boxCore) Connections(closed bool) []Connection {
	return c.tracked.list(closed)
}

func (c *boxCore) CloseConnection(id string) {
	c.mu.Lock()
	traffic := c.traffic
	c.mu.Unlock()
	if traffic == nil {
		return
	}
	if t := traffic.Connection(uuid.FromStringOrNil(id)); t != nil {
		t.Close()
	}
}

func (c *boxCore) CloseAllConnections() {
	c.mu.Lock()
	traffic, conns := c.traffic, c.conns
	c.mu.Unlock()
	if conns != nil {
		conns.CloseAll()
	}
	if traffic != nil {
		traffic.CloseAllConnections()
	}
	c.changed()
}

func (c *boxCore) ClearClosedConnections() {
	c.tracked.clearClosed()
	c.changed()
}

func (c *boxCore) Rules() []RuleInfo {
	c.mu.Lock()
	instance := c.instance
	c.mu.Unlock()
	if instance == nil {
		return nil
	}
	var rules []RuleInfo
	for i, r := range instance.Router().Rules() {
		rules = append(rules, RuleInfo{Index: i, Type: r.Type(), Rule: r.String(), Action: r.Action().String()})
	}
	return rules
}

func (c *boxCore) ClearDNSCache() {
	c.mu.Lock()
	ctx := c.ctx
	c.mu.Unlock()
	if ctx == nil {
		return
	}
	if r := service.FromContext[adapter.DNSRouter](ctx); r != nil {
		r.ClearCache()
	}
}

func (c *boxCore) QueryDNS(name, qtype string) (DNSResult, error) {
	c.mu.Lock()
	ctx := c.ctx
	c.mu.Unlock()
	if ctx == nil {
		return DNSResult{}, errNotRunning
	}
	router := service.FromContext[adapter.DNSRouter](ctx)
	if router == nil {
		return DNSResult{}, errNotRunning
	}
	return queryDNS(ctx, router, name, qtype)
}

// queryDNS asks a DNS router, as the clash API's /dns/query does.
func queryDNS(ctx context.Context, router adapter.DNSRouter, name, qtype string) (DNSResult, error) {
	name = strings.TrimSuffix(strings.TrimSpace(name), ".")
	if name == "" {
		return DNSResult{}, errors.New("填写要查询的域名")
	}
	if qtype == "" {
		qtype = "A"
	}
	t, ok := mDNS.StringToType[strings.ToUpper(qtype)]
	if !ok {
		return DNSResult{}, fmt.Errorf("不认识的记录类型 %s", qtype)
	}
	ctx, cancel := context.WithTimeout(ctx, C.DNSTimeout)
	defer cancel()
	msg := new(mDNS.Msg)
	msg.SetQuestion(mDNS.Fqdn(name), t)
	began := time.Now()
	resp, err := router.Exchange(ctx, msg, adapter.DNSQueryOptions{})
	if err != nil {
		return DNSResult{}, err
	}
	r := DNSResult{Rcode: mDNS.RcodeToString[resp.Rcode], Answers: []DNSAnswer{}, Took: int(time.Since(began).Milliseconds())}
	for _, rr := range resp.Answer {
		h := rr.Header()
		r.Answers = append(r.Answers, DNSAnswer{
			Name: strings.TrimSuffix(h.Name, "."),
			Type: mDNS.TypeToString[h.Rrtype],
			TTL:  h.Ttl,
			Data: strings.TrimSpace(rr.String()[len(h.String()):]),
		})
	}
	return r, nil
}

func (c *boxCore) ResetFakeIP() error {
	c.mu.Lock()
	ctx := c.ctx
	c.mu.Unlock()
	if ctx == nil {
		return errNotRunning
	}
	// The store of the FakeIP server: in the cache file with store_fakeip,
	// in memory otherwise; resetting the cache file alone would leave the
	// one in memory.
	transports := service.FromContext[adapter.DNSTransportManager](ctx)
	if transports == nil || transports.FakeIP() == nil {
		return errors.New("配置里没有 FakeIP DNS 服务器")
	}
	return transports.FakeIP().Store().Reset()
}

// notifyOn returns a subscriber that calls fn for every event, until closed.
func notifyOn(fn func()) *observable.Subscriber[struct{}] {
	sub := observable.NewSubscriber[struct{}](1)
	events, done := sub.Subscription()
	go func() {
		for {
			select {
			case <-events:
				fn()
			case <-done:
				return
			}
		}
	}()
	return sub
}

func equalFold(a, b string) bool { return strings.EqualFold(a, b) }
