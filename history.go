package main

import (
	"context"
	"net"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/trafficcontrol"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-tun"
	N "github.com/sagernet/sing/common/network"

	"github.com/gofrs/uuid/v5"
)

// historyLimit is how many connections the history keeps, open and
// closed, before dropping the oldest closed ones.
const historyLimit = 3000

// connRecord is a connection the core routed.
type connRecord struct {
	meta *trafficcontrol.TrackerMetadata
	// seq numbers the connections in the order they came, from 1.
	seq int64
	// logID is the ID the core's log lines of the connection carry,
	// zero when its context had none.
	logID    uint32
	closedAt time.Time
	// The totals once closed; while open they are read from meta.
	upload, download int64
	// The rates of the last second, while open, and the totals they were
	// measured from.
	uploadRate, downloadRate int64
	lastUp, lastDown         int64
	// routing is how long the connection took from being accepted to
	// its rule matched: sniffing, resolving and matching; zero unknown.
	routing time.Duration
	// flow is set for a flow of TUN routed before its connection, which
	// the history tracks itself: the traffic manager's ID is not known.
	flow   bool
	handle tun.FlowHandle
}

// connHistory records every connection the router hands to its trackers,
// synchronously, so that none is missed however short it lives. sing-box's
// own list of closed connections is cleared on every garbage collection,
// so the history keeps its own.
type connHistory struct {
	mu      sync.Mutex
	records []*connRecord
	byID    map[uuid.UUID]*connRecord
	seq     int64
	// closed are the totals of the closed connections, by outbound.
	closed map[string]OutboundTraffic
}

var _ adapter.ConnectionTracker = (*connHistory)(nil)

func newConnHistory() *connHistory {
	return &connHistory{byID: map[uuid.UUID]*connRecord{}, closed: map[string]OutboundTraffic{}}
}

type metadataTracker interface {
	Metadata() *trafficcontrol.TrackerMetadata
}

// add records a connection, given as wrapped by the traffic manager, which
// is the router's first tracker.
func (h *connHistory) add(ctx context.Context, conn any) {
	if t, ok := conn.(metadataTracker); ok {
		h.addMeta(ctx, t.Metadata(), false)
	}
}

func (h *connHistory) addMeta(ctx context.Context, meta *trafficcontrol.TrackerMetadata, flow bool) *connRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, loaded := h.byID[meta.ID]; loaded {
		return r
	}
	h.seq++
	r := &connRecord{meta: meta, seq: h.seq, flow: flow}
	if id, ok := log.IDFromContext(ctx); ok {
		r.logID = id.ID
		r.routing = max(meta.CreatedAt.Sub(id.CreatedAt), 0)
	}
	h.records = append(h.records, r)
	h.byID[meta.ID] = r
	if len(h.records) > historyLimit {
		h.trimLocked()
	}
	return r
}

// trimLocked drops the oldest closed records, a tenth at a time.
func (h *connHistory) trimLocked() {
	drop := len(h.records) - historyLimit*9/10
	kept := h.records[:0:0]
	for _, r := range h.records {
		if drop > 0 && !r.closedAt.IsZero() {
			delete(h.byID, r.meta.ID)
			drop--
			continue
		}
		kept = append(kept, r)
	}
	h.records = kept
}

func (h *connHistory) RoutedConnection(ctx context.Context, conn net.Conn, _ adapter.InboundContext, _ adapter.Rule, _ adapter.Outbound) net.Conn {
	h.add(ctx, conn)
	return conn
}

func (h *connHistory) RoutedPacketConnection(ctx context.Context, conn N.PacketConn, _ adapter.InboundContext, _ adapter.Rule, _ adapter.Outbound) N.PacketConn {
	h.add(ctx, conn)
	return conn
}

// RoutedFlow records a flow TUN routes before its connection: counted and
// closed through the tracker returned, as the traffic manager's own is.
func (h *connHistory) RoutedFlow(ctx context.Context, metadata adapter.InboundContext, rule adapter.Rule, outbound adapter.Outbound) tun.FlowTracker {
	chain := make([]string, 0, len(metadata.OutboundChain))
	for i := len(metadata.OutboundChain) - 1; i >= 0; i-- {
		chain = append(chain, metadata.OutboundChain[i].Tag())
	}
	meta := &trafficcontrol.TrackerMetadata{
		ID: uuid.Must(uuid.NewV4()), Metadata: metadata, CreatedAt: time.Now(),
		Upload: new(atomic.Int64), Download: new(atomic.Int64),
		Chain: chain, Rule: rule, Outbound: outbound.Tag(), OutboundType: outbound.Type(),
	}
	return &flowRecord{history: h, record: h.addMeta(ctx, meta, true)}
}

// flowRecord follows a flow for the history.
type flowRecord struct {
	history *connHistory
	record  *connRecord
}

func (f *flowRecord) AttachFlow(handle tun.FlowHandle) {
	f.history.mu.Lock()
	if f.record.closedAt.IsZero() {
		f.record.handle = handle
	}
	f.history.mu.Unlock()
}
func (f *flowRecord) CountForward(n int) { f.record.meta.Upload.Add(int64(n)) }
func (f *flowRecord) CountReverse(n int) { f.record.meta.Download.Add(int64(n)) }
func (f *flowRecord) FlowEstablished()   {}
func (f *flowRecord) CloseFlow(tun.FlowCloseReason) {
	h, r := f.history, f.record
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.closedAt.IsZero() {
		h.closeLocked(r, time.Now())
	}
}

// closeLocked marks a record closed with its final totals, which count
// toward its outbound's.
func (h *connHistory) closeLocked(r *connRecord, now time.Time) {
	r.closedAt = now
	r.upload, r.download = r.meta.Upload.Load(), r.meta.Download.Load()
	r.uploadRate, r.downloadRate, r.handle = 0, 0, nil
	t := h.closed[r.meta.Outbound]
	t.Upload += r.upload
	t.Download += r.download
	t.Connections++
	h.closed[r.meta.Outbound] = t
}

// OutboundTraffic is what went through an outbound while the core ran.
type OutboundTraffic struct {
	Upload      int64 `json:"upload"`
	Download    int64 `json:"download"`
	Connections int   `json:"connections"`
	// Open are the connections through it now.
	Open int `json:"open"`
}

// outbounds returns the traffic of each outbound since the core started:
// the closed connections, kept apart from the records, which are trimmed,
// and the open ones as they are now.
func (h *connHistory) outbounds() map[string]OutboundTraffic {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make(map[string]OutboundTraffic, len(h.closed))
	for tag, t := range h.closed {
		out[tag] = t
	}
	for _, r := range h.records {
		if !r.closedAt.IsZero() {
			continue
		}
		t := out[r.meta.Outbound]
		t.Upload += r.meta.Upload.Load()
		t.Download += r.meta.Download.Load()
		t.Connections++
		t.Open++
		out[r.meta.Outbound] = t
	}
	return out
}

// closeFlow closes a flow of the history by its ID, reporting whether
// there was one: the traffic manager knows it by another.
func (h *connHistory) closeFlow(id uuid.UUID) bool {
	h.mu.Lock()
	r := h.byID[id]
	var handle tun.FlowHandle
	if r != nil && r.flow {
		handle = r.handle
	}
	h.mu.Unlock()
	if handle == nil {
		return false
	}
	handle.CloseFlow()
	return true
}

// reconcile marks the records whose connections the traffic manager no
// longer has as closed, with their final totals, and measures the rates
// of the others: it runs once a second.
func (h *connHistory) reconcile(traffic *trafficcontrol.Manager, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.records {
		if !r.closedAt.IsZero() {
			continue
		}
		up, down := r.meta.Upload.Load(), r.meta.Download.Load()
		// A flow closes through its tracker.
		if !r.flow && traffic.Connection(r.meta.ID) == nil {
			h.closeLocked(r, now)
			continue
		}
		r.uploadRate, r.downloadRate = max(up-r.lastUp, 0), max(down-r.lastDown, 0)
		r.lastUp, r.lastDown = up, down
	}
}

// closeAll marks every record closed, as the core stops.
func (h *connHistory) closeAll(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.records {
		if r.closedAt.IsZero() {
			h.closeLocked(r, now)
		}
	}
}

// clearClosed forgets the closed records.
func (h *connHistory) clearClosed() {
	h.mu.Lock()
	defer h.mu.Unlock()
	kept := h.records[:0:0]
	for _, r := range h.records {
		if r.closedAt.IsZero() {
			kept = append(kept, r)
		} else {
			delete(h.byID, r.meta.ID)
		}
	}
	h.records = kept
}

// list returns the records, newest first.
func (h *connHistory) list(closed bool) []Connection {
	h.mu.Lock()
	records := slices.Clone(h.records)
	h.mu.Unlock()
	out := make([]Connection, 0, len(records))
	for i := len(records) - 1; i >= 0; i-- {
		r := records[i]
		h.mu.Lock()
		closedAt, up, down := r.closedAt, r.upload, r.download
		upRate, downRate := r.uploadRate, r.downloadRate
		h.mu.Unlock()
		if closed != !closedAt.IsZero() {
			continue
		}
		if closedAt.IsZero() {
			up, down = r.meta.Upload.Load(), r.meta.Download.Load()
		}
		c := toConnection(r.meta, closedAt, up, down)
		c.Seq, c.LogID, c.UploadRate, c.DownloadRate = r.seq, r.logID, upRate, downRate
		c.RoutingMs, c.Flow = int(r.routing.Milliseconds()), r.flow
		out = append(out, c)
	}
	return out
}

func toConnection(m *trafficcontrol.TrackerMetadata, closedAt time.Time, up, down int64) Connection {
	md := m.Metadata
	c := Connection{
		ID:           m.ID.String(),
		Inbound:      md.Inbound,
		InboundType:  md.InboundType,
		Network:      md.Network,
		Source:       md.Source.String(),
		Destination:  md.Destination.String(),
		Domain:       md.Domain,
		Protocol:     md.Protocol,
		Client:       md.Client,
		FakeIP:       md.FakeIP,
		User:         md.User,
		Outbound:     m.Outbound,
		OutboundType: m.OutboundType,
		Chain:        slices.Clone(m.Chain),
		Upload:       up,
		Download:     down,
		CreatedAt:    m.CreatedAt.Truncate(time.Millisecond),
	}
	if c.Chain == nil {
		c.Chain = []string{}
	}
	c.Addresses = make([]string, len(md.DestinationAddresses))
	for i, a := range md.DestinationAddresses {
		c.Addresses[i] = a.String()
	}
	// Where the connection went first, when a rule sent it elsewhere.
	if md.OriginDestination.IsValid() && md.OriginDestination != md.Destination {
		c.OriginDestination = md.OriginDestination.String()
	}
	if m.Rule != nil {
		c.Rule = m.Rule.String() + " => " + m.Rule.Action().String()
	} else {
		c.Rule = "final"
	}
	if md.IPVersion != 0 {
		c.IPVersion = int(md.IPVersion)
	}
	if p := md.ProcessInfo; p != nil {
		if len(p.ProcessPaths) > 0 {
			c.ProcessPath = p.ProcessPaths[0]
			c.Process = p.ProcessPaths[0][strings.LastIndexAny(p.ProcessPaths[0], `/\`)+1:]
		}
		// The process that opened the socket, when it did so for the app.
		if len(p.ProcessPaths) > 1 {
			c.ViaPath = p.ProcessPaths[1]
		}
		c.ProcessID = int(p.ProcessID)
	}
	if !closedAt.IsZero() {
		c.ClosedAt = closedAt.Truncate(time.Millisecond)
	}
	return c
}
