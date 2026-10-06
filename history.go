package main

import (
	"context"
	"net"
	"slices"
	"strings"
	"sync"
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
}

var _ adapter.ConnectionTracker = (*connHistory)(nil)

func newConnHistory() *connHistory {
	return &connHistory{byID: map[uuid.UUID]*connRecord{}}
}

type metadataTracker interface {
	Metadata() *trafficcontrol.TrackerMetadata
}

// add records a connection, given as wrapped by the traffic manager, which
// is the router's first tracker.
func (h *connHistory) add(ctx context.Context, conn any) {
	t, ok := conn.(metadataTracker)
	if !ok {
		return
	}
	meta := t.Metadata()
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, loaded := h.byID[meta.ID]; loaded {
		return
	}
	h.seq++
	r := &connRecord{meta: meta, seq: h.seq}
	if id, ok := log.IDFromContext(ctx); ok {
		r.logID = id.ID
	}
	h.records = append(h.records, r)
	h.byID[meta.ID] = r
	if len(h.records) > historyLimit {
		h.trimLocked()
	}
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

func (h *connHistory) RoutedFlow(context.Context, adapter.InboundContext, adapter.Rule, adapter.Outbound) tun.FlowTracker {
	return nil
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
		if traffic.Connection(r.meta.ID) == nil {
			r.closedAt = now
			r.upload, r.download = up, down
			r.uploadRate, r.downloadRate = 0, 0
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
			r.closedAt = now
			r.upload, r.download = r.meta.Upload.Load(), r.meta.Download.Load()
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
			c.Process = p.ProcessPaths[0][strings.LastIndex(p.ProcessPaths[0], "/")+1:]
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
