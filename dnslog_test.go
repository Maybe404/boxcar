package main

import (
	"context"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	sbdns "github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/log"

	mDNS "github.com/miekg/dns"
)

// fakeTransport answers as a DNS server would, without the network.
type fakeTransport struct {
	tag    string
	answer func(q mDNS.Question) ([]mDNS.RR, error)
}

func (f *fakeTransport) Start(adapter.StartStage, *adapter.Scope) error { return nil }
func (f *fakeTransport) Close() error                                   { return nil }
func (f *fakeTransport) Type() string                                   { return "https" }
func (f *fakeTransport) Tag() string                                    { return f.tag }
func (f *fakeTransport) Dependencies() []string                         { return nil }
func (f *fakeTransport) Reset()                                         {}
func (f *fakeTransport) Exchange(_ context.Context, m *mDNS.Msg) (*mDNS.Msg, error) {
	answers, err := f.answer(m.Question[0])
	if err != nil {
		return nil, err
	}
	r := new(mDNS.Msg)
	r.SetReply(m)
	r.Answer = answers
	return r, nil
}

func (f *fakeTransport) ExchangeAsync(ctx context.Context, m *mDNS.Msg, callback func(*mDNS.Msg, error)) {
	callback(f.Exchange(ctx, m))
}

func rr(t *testing.T, s string) mDNS.RR {
	t.Helper()
	r, err := mDNS.NewRR(s)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// coreLogger is the core's own logger, writing to b as the platform
// writer does in the app: the lines are the core's own wording.
func coreLogger(b *logBuffer) log.ContextLogger {
	factory := log.NewDefaultFactory(context.Background(), log.Formatter{BaseTime: time.Now()}, io.Discard, "", b, false)
	factory.SetLevel(log.LevelTrace)
	// Lines wait until the factory starts, as the core starts it.
	factory.Start()
	return factory.NewLogger("dns")
}

func TestDNSLogFromTheCoresOwnLines(t *testing.T) {
	b := newLogBuffer(100)
	b.setLevel(log.LevelInfo)
	b.dns.setServers("dns-remote", map[string]string{"dns-remote": "https", "dns-cn": "https", "hosts": "hosts"})
	logger := coreLogger(b)
	client := sbdns.NewClient(sbdns.ClientOptions{Context: context.Background(), Timeout: 5 * time.Second, Logger: logger})
	server := &fakeTransport{tag: "dns-cn", answer: func(q mDNS.Question) ([]mDNS.RR, error) {
		switch q.Name {
		case "www.example.cn.":
			return []mDNS.RR{rr(t, "www.example.cn. 300 IN CNAME edge.example.cn."), rr(t, "edge.example.cn. 300 IN A 1.2.3.4")}, nil
		case "broken.example.":
			return nil, errors.New("i/o timeout")
		}
		return nil, nil
	}}

	// A query of an app, routed by a rule: the router's lines, then the
	// client's, under the ID of the connection that asked.
	ctx := log.ContextWithID(context.Background(), log.ID{ID: 4242, CreatedAt: time.Now()})
	logger.DebugContext(ctx, "exchange ", sbdns.FormatQuestion((&mDNS.Question{Name: "www.example.cn.", Qtype: mDNS.TypeA, Qclass: mDNS.ClassINET}).String()))
	logger.DebugContext(ctx, "match[1] rule_set=geosite-cn => route(dns-cn)")
	query := func(name string) {
		m := new(mDNS.Msg)
		m.SetQuestion(name, mDNS.TypeA)
		if _, err := client.Exchange(ctx, server, m, adapter.DNSQueryOptions{}, nil); err != nil {
			logger.ErrorContext(ctx, "exchange failed for ", sbdns.FormatQuestion(m.Question[0].String()), ": ", err)
		}
	}
	query("www.example.cn.")
	// Again, from the cache, without a rule: the default server.
	logger.DebugContext(ctx, "exchange ", "www.example.cn. IN A")
	query("www.example.cn.")
	query("broken.example.")

	got := b.dns.list("", 10)
	if len(got) != 3 {
		t.Fatalf("records %+v", got)
	}
	failed, cached, exchanged := got[0], got[1], got[2]
	if exchanged.Source != "exchanged" || exchanged.Domain != "www.example.cn" || exchanged.Type != "A" || exchanged.Rcode != "NOERROR" || exchanged.Server != "dns-cn" || !exchanged.ByRule || exchanged.LogID != 4242 {
		t.Fatalf("exchanged %+v", exchanged)
	}
	if !slices.Equal(exchanged.Answers, []string{"CNAME edge.example.cn.", "A 1.2.3.4"}) {
		t.Fatalf("answers %v", exchanged.Answers)
	}
	if cached.Source != "cached" || cached.Server != "dns-remote" || cached.ByRule || len(cached.Answers) != 2 {
		t.Fatalf("cached %+v", cached)
	}
	if failed.Source != "failed" || failed.Domain != "broken.example" || !strings.Contains(failed.Error, "i/o timeout") {
		t.Fatalf("failed %+v", failed)
	}
	// The connection's lines, every level, though the log is at info.
	if lines := b.conns.get(4242); len(lines) < 6 {
		t.Fatalf("connection lines %d", len(lines))
	}
	// A failed DNS query is not the connection's failure; a failed dial is.
	if e := b.conns.errorOf(4242); e != "" {
		t.Fatalf("a DNS error as the connection's: %q", e)
	}
	outbound := log.NewDefaultFactory(context.Background(), log.Formatter{}, io.Discard, "", b, false)
	outbound.Start()
	outbound.NewLogger("outbound/direct[direct]").ErrorContext(ctx, "open connection to www.example.cn:443: refused")
	if e := b.conns.errorOf(4242); e != "outbound/direct[direct]: open connection to www.example.cn:443: refused" {
		t.Fatalf("error %q", e)
	}
	if lines, _ := b.snapshot(log.LevelTrace, "", ""); slices.ContainsFunc(lines, func(e logEntry) bool { return e.Level > log.LevelInfo }) {
		t.Fatal("finer lines than the configuration's reached the log page")
	}
}

func TestDNSLookupAsksTwoTypes(t *testing.T) {
	b := newLogBuffer(100)
	b.dns.setServers("local", map[string]string{"local": "local"})
	logger := coreLogger(b)
	client := sbdns.NewClient(sbdns.ClientOptions{Context: context.Background(), Timeout: 5 * time.Second, Logger: logger})
	server := &fakeTransport{tag: "local", answer: func(q mDNS.Question) ([]mDNS.RR, error) {
		if q.Qtype == mDNS.TypeAAAA {
			return []mDNS.RR{rr(t, "example.com. 60 IN AAAA 2001:db8::1")}, nil
		}
		return []mDNS.RR{rr(t, "example.com. 60 IN A 192.0.2.1")}, nil
	}}
	ctx := log.ContextWithID(context.Background(), log.ID{ID: 7, CreatedAt: time.Now()})
	logger.DebugContext(ctx, "lookup domain example.com")
	logger.DebugContext(ctx, "match[0] => route(local)")
	addrs, err := client.Lookup(ctx, server, "example.com", adapter.DNSQueryOptions{}, nil)
	if err != nil || len(addrs) != 2 {
		t.Fatalf("lookup %v %v", addrs, err)
	}
	got := b.dns.list("", 10)
	types := []string{}
	for _, r := range got {
		if r.Server != "local" || r.ServerType != "local" || !r.ByRule || len(r.Answers) != 1 || !strings.HasPrefix(r.Answers[0], r.Type+" ") {
			t.Fatalf("record %+v", r)
		}
		types = append(types, r.Type)
	}
	slices.Sort(types)
	if !slices.Equal(types, []string{"A", "AAAA"}) {
		t.Fatalf("types %v", types)
	}
}

func TestConnectionErrorWithoutItsID(t *testing.T) {
	c := newConnLogs()
	c.add(5, logEntry{Level: log.LevelInfo, Message: "[5 0ms] inbound/mixed[in]: inbound connection to x:443"})
	c.add(5, logEntry{Level: log.LevelError, Message: "[5 1.02s] outbound/direct[d]: open connection to x:443: refused"})
	c.add(5, logEntry{Level: log.LevelError, Message: "[5 1.03s] later"})
	if e := c.errorOf(5); e != "outbound/direct[d]: open connection to x:443: refused" {
		t.Fatalf("error %q", e)
	}
}
