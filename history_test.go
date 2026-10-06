package main

import (
	"context"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/trafficcontrol"
	"github.com/sagernet/sing-box/log"
	M "github.com/sagernet/sing/common/metadata"

	"github.com/gofrs/uuid/v5"
)

type trackedConn struct {
	meta *trafficcontrol.TrackerMetadata
}

// newMeta is the metadata as the traffic manager makes it, counters and all.
func newMeta(md adapter.InboundContext) *trafficcontrol.TrackerMetadata {
	return &trafficcontrol.TrackerMetadata{ID: uuid.Must(uuid.NewV4()), Metadata: md, CreatedAt: time.Now(), Upload: new(atomic.Int64), Download: new(atomic.Int64)}
}

func (c trackedConn) Metadata() *trafficcontrol.TrackerMetadata { return c.meta }

func TestHistoryRecordsWhatTheCoreKnows(t *testing.T) {
	h := newConnHistory()
	meta := newMeta(adapter.InboundContext{
		Network:              "tcp",
		Destination:          M.ParseSocksaddr("93.184.215.14:443"),
		OriginDestination:    M.ParseSocksaddr("198.18.0.5:443"),
		Domain:               "example.com",
		Protocol:             "tls",
		Client:               "chromium",
		FakeIP:               true,
		DestinationAddresses: []netip.Addr{netip.MustParseAddr("93.184.215.14")},
		ProcessInfo:          &adapter.ConnectionOwner{ProcessPaths: []string{"/Applications/Dia.app/Contents/MacOS/Dia", "/usr/libexec/nsurlsessiond"}},
	})
	ctx := log.ContextWithID(context.Background(), log.ID{ID: 1234567, CreatedAt: time.Now()})
	h.add(ctx, trackedConn{meta})
	h.add(context.Background(), trackedConn{newMeta(adapter.InboundContext{})})

	list := h.list(false)
	if len(list) != 2 || list[0].Seq != 2 || list[1].Seq != 1 {
		t.Fatalf("not newest first, numbered: %+v", list)
	}
	c := list[1]
	if c.LogID != 1234567 || c.Client != "chromium" || !c.FakeIP || c.OriginDestination != "198.18.0.5:443" {
		t.Fatalf("connection %+v", c)
	}
	if len(c.Addresses) != 1 || c.Addresses[0] != "93.184.215.14" {
		t.Fatalf("addresses %v", c.Addresses)
	}
	if c.Process != "Dia" || c.ViaPath != "/usr/libexec/nsurlsessiond" {
		t.Fatalf("process %q via %q", c.Process, c.ViaPath)
	}
	if list[0].LogID != 0 || list[0].Addresses == nil {
		t.Fatalf("without a log ID or addresses: %+v", list[0])
	}
}

func TestQueryDNSChecksItsInput(t *testing.T) {
	// Both fail before the router is asked.
	if _, err := queryDNS(context.Background(), nil, " . ", "A"); err == nil {
		t.Fatal("an empty name was queried")
	}
	if _, err := queryDNS(context.Background(), nil, "example.com", "BOGUS"); err == nil {
		t.Fatal("an unknown type was queried")
	}
}

func TestSubscriptionErrorsLeaveTheAddressOut(t *testing.T) {
	// Cancelled before it starts: nothing is sent anywhere.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := fetchProfile(ctx, "https://example.com/sub?token=SECRET")
	if err == nil || strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "example.com") {
		t.Fatalf("error %v", err)
	}
}
