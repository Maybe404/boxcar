package main

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/log"
)

// The core tells of its DNS queries only in its log: which query, which
// rule routed it to which server, whether it was answered from the cache,
// and the records. The lines of one query share the ID of the connection
// or lookup that made it. dnsLog puts them back together, one record for
// each answer. It reads the core's wording, which the tests pin.

// DNSRecord is a DNS query the core answered, or failed to.
type DNSRecord struct {
	Time time.Time `json:"time"`
	// LogID is the ID its log lines carry, which a connection's shares;
	// zero for a query of the core's own, as for a rule-set download.
	LogID  uint32 `json:"logId,omitempty"`
	Domain string `json:"domain"`
	// Type is the type asked, as A or AAAA; empty when the log did not
	// tell it, as for a lookup answered without records.
	Type string `json:"type,omitempty"`
	// Source is how it was answered: exchanged (asked the server),
	// cached, optimistic (a stale answer served while refreshing),
	// refreshed, rejected, or failed.
	Source string `json:"source"`
	Rcode  string `json:"rcode,omitempty"`
	TTL    int    `json:"ttl,omitempty"`
	// Answers are the records, as "A 93.184.215.14".
	Answers []string `json:"answers"`
	// Server is the DNS server's tag, from the rule that routed the query,
	// or the default server when no rule did.
	Server string `json:"server,omitempty"`
	// ServerType is the server's type, as hosts, local, fakeip or https.
	ServerType string `json:"serverType,omitempty"`
	// ByRule is set when a DNS rule chose the server.
	ByRule bool   `json:"byRule,omitempty"`
	Error  string `json:"error,omitempty"`
}

const dnsRecordLimit = 3000

type dnsLog struct {
	mu      sync.Mutex
	records []*DNSRecord
	// The server a rule chose for an ID's query, until it is answered.
	routed map[uint32]string
	// The servers of the configuration running: the default, and types.
	defaultServer string
	serverTypes   map[string]string
	version       int
}

func newDNSLog() *dnsLog {
	return &dnsLog{routed: map[uint32]string{}, serverTypes: map[string]string{}}
}

// setServers tells the servers of the configuration that runs.
func (d *dnsLog) setServers(defaultTag string, types map[string]string) {
	d.mu.Lock()
	d.defaultServer, d.serverTypes = defaultTag, types
	d.mu.Unlock()
}

var (
	// "exchange example.com. IN A", the question as asked.
	dnsExchange = regexp.MustCompile(`^exchange (\S+)\.? IN (\S+)$`)
	// "match[2] rule_set=geosite-cn => route(dns-cn,disable-cache)", or
	// evaluate(…), which asks a server the same way.
	dnsRouted = regexp.MustCompile(`^match\[\d+\] .*=> (?:route|evaluate)\(([^,)]+)`)
	// "exchanged example.com NOERROR 300", how it was answered.
	dnsSummary = regexp.MustCompile(`^(exchanged|cached|optimistic|refreshed) (\S+) ([A-Z]+) (-?\d+)$`)
	// "exchanged A example.com. 300 IN A 93.184.215.14", a record.
	dnsAnswer = regexp.MustCompile(`^(exchanged|cached|optimistic|refreshed|rejected) ([A-Z0-9]+) (\S+?)\.? (\d+) IN [A-Z0-9]+ (.*)$`)
	// "lookup domain example.com", a lookup for a connection, which asks
	// A and AAAA, routed by one match.
	dnsLookup = regexp.MustCompile(`^lookup domain (\S+)$`)
	// "exchange failed for example.com. IN A: i/o timeout".
	dnsFailed = regexp.MustCompile(`^exchange failed for (\S+?)\.? IN (\S+): (.*)$`)
	// "lookup failed for example.com: no such host".
	dnsLookupFailed = regexp.MustCompile(`^lookup failed for (\S+?): (.*)$`)
)

// add reads a line of the core's log, its ID taken off.
func (d *dnsLog) add(id uint32, tag, body string, now time.Time) {
	if tag != "dns" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case dnsLookup.MatchString(body):
		// A query starts: the server routed before was another's.
		delete(d.routed, id)
		return
	case dnsRouted.MatchString(body):
		if len(d.routed) > 4096 {
			d.routed = map[uint32]string{}
		}
		d.routed[id] = dnsRouted.FindStringSubmatch(body)[1]
		return
	case dnsExchange.MatchString(body):
		m := dnsExchange.FindStringSubmatch(body)
		delete(d.routed, id)
		d.open(id, m[1], m[2], "", now)
	case dnsSummary.MatchString(body):
		m := dnsSummary.FindStringSubmatch(body)
		r := d.pending(id, m[2], "")
		if r == nil {
			r = d.open(id, m[2], "", "", now)
		}
		r.Source, r.Rcode = m[1], m[3]
		r.TTL, _ = strconv.Atoi(m[4])
		d.settle(id, r)
	case dnsAnswer.MatchString(body):
		m := dnsAnswer.FindStringSubmatch(body)
		r := d.answered(id, m[3], m[1], m[2])
		if r == nil {
			// A rejected answer has no summary line before it.
			r = d.open(id, m[3], m[2], m[1], now)
			d.settle(id, r)
		}
		// The type asked, unless the answer starts with an alias.
		if r.Type == "" && m[2] != "CNAME" {
			r.Type = m[2]
		}
		r.Answers = append(r.Answers, m[2]+" "+m[5])
		if r.TTL == 0 {
			r.TTL, _ = strconv.Atoi(m[4])
		}
	case dnsFailed.MatchString(body):
		m := dnsFailed.FindStringSubmatch(body)
		r := d.pending(id, m[1], m[2])
		if r == nil {
			r = d.open(id, m[1], m[2], "", now)
		}
		r.Source, r.Error = "failed", m[3]
		d.settle(id, r)
	case dnsLookupFailed.MatchString(body):
		m := dnsLookupFailed.FindStringSubmatch(body)
		r := d.pending(id, m[1], "")
		if r == nil {
			r = d.open(id, m[1], "", "", now)
		}
		r.Source, r.Error = "failed", m[2]
		d.settle(id, r)
	default:
		return
	}
	d.version++
}

// open starts a record of a query.
func (d *dnsLog) open(id uint32, domain, qtype, source string, now time.Time) *DNSRecord {
	r := &DNSRecord{Time: now.Truncate(time.Millisecond), LogID: id, Domain: strings.TrimSuffix(domain, "."), Type: qtype, Source: source, Answers: []string{}}
	d.records = append(d.records, r)
	if len(d.records) > dnsRecordLimit {
		d.records = append(d.records[:0:0], d.records[len(d.records)-dnsRecordLimit*9/10:]...)
	}
	return r
}

// settle gives a record its server: the rule's, or the default.
func (d *dnsLog) settle(id uint32, r *DNSRecord) {
	if server, ok := d.routed[id]; ok {
		r.Server, r.ByRule = server, true
	} else if r.Server == "" {
		r.Server = d.defaultServer
	}
	r.ServerType = d.serverTypes[r.Server]
}

// pending finds the last record of an ID and domain not yet answered.
func (d *dnsLog) pending(id uint32, domain, qtype string) *DNSRecord {
	domain = strings.TrimSuffix(domain, ".")
	for i := len(d.records) - 1; i >= 0 && i >= len(d.records)-64; i-- {
		r := d.records[i]
		if r.LogID == id && r.Domain == domain && r.Source == "" && (qtype == "" || r.Type == "" || r.Type == qtype) {
			return r
		}
	}
	return nil
}

// answered finds the record a record line belongs to: of the same ID and
// source, asked of that type, or of no type yet; a CNAME's target is
// another domain in the same answer.
func (d *dnsLog) answered(id uint32, domain, source, rtype string) *DNSRecord {
	domain = strings.TrimSuffix(domain, ".")
	var untyped, any *DNSRecord
	for i := len(d.records) - 1; i >= 0 && i >= len(d.records)-64; i-- {
		r := d.records[i]
		if r.LogID != id || r.Source != source || (r.Domain != domain && len(r.Answers) == 0) {
			continue
		}
		switch {
		case r.Type == rtype:
			return r
		case r.Type == "" && untyped == nil:
			untyped = r
		case any == nil:
			any = r
		}
	}
	if untyped != nil {
		return untyped
	}
	return any
}

// list returns the records that contain query, newest first, at most
// limit.
func (d *dnsLog) list(query string, limit int) []DNSRecord {
	d.mu.Lock()
	defer d.mu.Unlock()
	query = strings.ToLower(query)
	out := []DNSRecord{}
	for i := len(d.records) - 1; i >= 0 && len(out) < limit; i-- {
		r := d.records[i]
		if r.Source == "" {
			// Still being answered.
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(r.Domain+" "+strings.Join(r.Answers, " ")+" "+r.Server), query) {
			continue
		}
		c := *r
		c.Answers = append([]string{}, r.Answers...)
		out = append(out, c)
	}
	return out
}

func (d *dnsLog) clear() {
	d.mu.Lock()
	d.records, d.routed = nil, map[uint32]string{}
	d.version++
	d.mu.Unlock()
}

// The lines of each connection, by the ID they carry, so that a
// connection's whole story can be shown: sniffing, the rules matched, DNS,
// the outbound, and errors. Every level is kept, whatever the
// configuration logs at, within limits.

const (
	connLogIDs   = 4000
	connLogLines = 200
)

type connLogs struct {
	mu    sync.Mutex
	lines map[uint32][]logEntry
	order []uint32
	// errs are the first error each ID logged.
	errs map[uint32]string
}

func newConnLogs() *connLogs {
	return &connLogs{lines: map[uint32][]logEntry{}, errs: map[uint32]string{}}
}

func (c *connLogs) add(id uint32, e logEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	lines, seen := c.lines[id]
	if !seen {
		c.order = append(c.order, id)
		if len(c.order) > connLogIDs {
			drop := len(c.order) - connLogIDs*9/10
			for _, old := range c.order[:drop] {
				delete(c.lines, old)
				delete(c.errs, old)
			}
			c.order = append(c.order[:0:0], c.order[drop:]...)
		}
	}
	if len(lines) < connLogLines {
		c.lines[id] = append(lines, e)
	}
	// A failed DNS query of a connection is not its failure: an AAAA may
	// fail while the A answers.
	if _, tag, _ := splitLine(e.Message); e.Level <= log.LevelError && tag != "dns" {
		if _, ok := c.errs[id]; !ok {
			// Without "[1234567 12ms] ": the ID is the connection's own.
			c.errs[id] = idLine.ReplaceAllString(e.Message, "$2")
		}
	}
}

func (c *connLogs) get(id uint32) []logEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]logEntry(nil), c.lines[id]...)
}

func (c *connLogs) errorOf(id uint32) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.errs[id]
}

func (c *connLogs) clear() {
	c.mu.Lock()
	c.lines, c.order, c.errs = map[uint32][]logEntry{}, nil, map[uint32]string{}
	c.mu.Unlock()
}

// idLine is "[1234567 12ms] rest": the ID of a line, and the rest.
var idLine = regexp.MustCompile(`^\[(\d+) [^\]]*\] (.*)$`)

// splitLine takes a cleaned line apart: its ID (zero without one), its
// tag, as dns or outbound/vless[hk], and what it says.
func splitLine(message string) (uint32, string, string) {
	var id uint32
	rest := message
	if m := idLine.FindStringSubmatch(message); m != nil {
		v, _ := strconv.ParseUint(m[1], 10, 32)
		id, rest = uint32(v), m[2]
	}
	if m := tagEnd.FindStringSubmatch(rest); m != nil {
		return id, m[1], rest[len(m[0]):]
	}
	return id, "", rest
}
