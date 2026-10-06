package main

import (
	"runtime/debug"
	"slices"
	"strings"
)

// optionalTypes are the types the core includes only with a build tag:
// without it, a stub takes their place, which fails as the configuration
// is checked or started. The form offers every type of the schema, so it
// marks these. Kept in step with sing-box's include/*_stub.go.
var optionalTypes = []struct {
	tag string
	// cgo is set when the type needs cgo on macOS as well.
	cgo   bool
	types []string
}{
	{"with_quic", false, []string{"inbounds/hysteria", "inbounds/hysteria2", "inbounds/tuic", "outbounds/hysteria", "outbounds/hysteria2", "outbounds/tuic", "dns.servers/quic", "dns.servers/h3", "services/hysteria-realm"}},
	{"with_wireguard", false, []string{"endpoints/wireguard"}},
	{"with_tailscale", false, []string{"endpoints/tailscale", "inbounds/tailcat", "outbounds/tailcat", "dns.servers/tailscale", "certificate_providers/tailscale", "services/derp"}},
	{"with_dhcp", false, []string{"dns.servers/dhcp"}},
	{"with_acme", false, []string{"certificate_providers/acme"}},
	{"with_naive_outbound", false, []string{"outbounds/naive"}},
	{"with_cloudflared", false, []string{"inbounds/cloudflared"}},
	{"with_ccm", true, []string{"services/ccm"}},
	{"with_ocm", false, []string{"services/ocm"}},
	{"with_openconnect", false, []string{"endpoints/openconnect", "dns.servers/openconnect"}},
	{"with_openvpn", false, []string{"endpoints/openvpn-client", "endpoints/openvpn-server", "dns.servers/openvpn"}},
	{"with_usbip", true, []string{"services/usbip-client", "services/usbip-server"}},
}

// buildTags returns the build tags of the binary, and whether cgo was on.
func buildTags() ([]string, bool) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return nil, false
	}
	var tags []string
	cgo := false
	for _, s := range info.Settings {
		switch s.Key {
		case "-tags":
			tags = strings.Split(s.Value, ",")
		case "CGO_ENABLED":
			cgo = s.Value == "1"
		}
	}
	return tags, cgo
}

// missingTypes lists the types this build leaves out, as section/type:
// "outbounds/naive".
func missingTypes(tags []string, cgo bool) []string {
	missing := []string{}
	for _, o := range optionalTypes {
		if !slices.Contains(tags, o.tag) || (o.cgo && !cgo) {
			missing = append(missing, o.types...)
		}
	}
	return missing
}
