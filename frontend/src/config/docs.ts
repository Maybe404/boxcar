// What the core's documentation says about each field, in Chinese
// (tools/configschema extracts it). A field is looked up in the documents
// of where it is: an outbound of type vless in outbound/vless, then the
// shared dial fields, and so on.
import raw from "./gen/docs.json";
import { defName, type Node } from "./schema";
import type { Json } from "./path";

export interface FieldDoc {
  text?: string;
  required?: boolean;
  /** Where the field applies, as 仅客户端. */
  scope?: string;
  since?: string;
  /** The notice of the field itself: deprecated, removed, not recommended. */
  deprecated?: string;
  /** The values the documentation lists as available. */
  values?: string[];
}

const all = (raw as { version: string; docs: Record<string, Record<string, FieldDoc>> }).docs;
export const coreVersion = (raw as { version: string }).version;

/** The field documented once only, or the same everywhere: safe to use anywhere. */
const unique = (() => {
  const by = new Map<string, FieldDoc | null>();
  for (const fields of Object.values(all)) {
    for (const [k, f] of Object.entries(fields)) {
      const prev = by.get(k);
      if (prev === undefined) by.set(k, f);
      else if (prev && prev.text !== f.text) by.set(k, null);
    }
  }
  return by;
})();

/** The documents of the items of the configuration's sections; {type} is the item's type. */
const sectionDocs: Record<string, string[]> = {
  log: ["log"],
  dns: ["dns", "dns/fakeip"],
  ntp: ["ntp", "shared/dial"],
  certificate: ["certificate"],
  certificate_providers: ["shared/certificate-provider/{type}", "shared/certificate-provider"],
  http_clients: ["shared/http-client", "shared/http2", "shared/quic", "shared/dial"],
  network_namespaces: ["network-namespace/{type}", "network-namespace/default", "network-namespace"],
  endpoints: ["endpoint/{type}", "endpoint", "shared/dial", "shared/listen"],
  inbounds: ["inbound/{type}", "inbound", "shared/listen"],
  outbounds: ["outbound/{type}", "outbound", "shared/dial"],
  route: ["route"],
  services: ["service/{type}", "service", "shared/listen"],
  experimental: ["experimental"],
  "dns.servers": ["dns/server/{type}", "dns/server", "shared/dial"],
  "dns.rules": ["dns/rule", "dns/rule_action"],
  "route.rules": ["route/rule", "route/rule_action"],
  "route.rule_set": ["rule-set"],
};

/** The documents of the definitions the schema refers to. */
const defDocs: Record<string, string[]> = {
  OutboundTLSOptions: ["shared/tls"],
  InboundTLSOptions: ["shared/tls"],
  OutboundECHOptions: ["shared/tls"],
  InboundECHOptions: ["shared/tls"],
  OutboundUTLSOptions: ["shared/tls"],
  OutboundRealityOptions: ["shared/tls"],
  InboundRealityOptions: ["shared/tls"],
  InboundRealityHandshakeOptions: ["shared/tls", "shared/dial"],
  V2RayTransport: ["shared/v2ray-transport"],
  OutboundMultiplexOptions: ["shared/multiplex"],
  InboundMultiplexOptions: ["shared/multiplex"],
  BrutalOptions: ["shared/tcp-brutal"],
  DomainResolver: ["dns/rule_action", "shared/dial"],
  HTTPClientReference: ["shared/http-client", "shared/dial"],
  HTTPClient: ["shared/http-client", "shared/dial"],
  HeadlessRule: ["rule-set/headless-rule"],
  NestedRule: ["route/rule"],
  NestedDNSRule: ["dns/rule"],
  Rule: ["route/rule", "route/rule_action"],
  DNSRule: ["dns/rule", "dns/rule_action"],
  RuleSet: ["rule-set"],
  CacheFileOptions: ["experimental/cache-file"],
  ClashAPIOptions: ["experimental/clash-api"],
  V2RayAPIOptions: ["experimental/v2ray-api"],
  V2RayStatsServiceOptions: ["experimental/v2ray-api"],
  ACMEProviderDNS01Challenge: ["shared/dns01_challenge"],
  CertificateProviderReference: ["shared/certificate-provider"],
  DialerOptions: ["shared/dial"],
  ServerOptions: ["shared/dial"],
  ShadowTLSHandshakeOptions: ["outbound/shadowtls", "shared/dial"],
  WireGuardPeer: ["endpoint/wireguard"],
  TunPlatformOptions: ["inbound/tun"],
  HTTPProxyOptions: ["inbound/tun"],
};

/** The documents of fields named alike wherever they are. */
const keyDocs: Record<string, string[]> = {
  tls: ["shared/tls"],
  transport: ["shared/v2ray-transport"],
  multiplex: ["shared/multiplex"],
  brutal: ["shared/tcp-brutal"],
  udp_over_tcp: ["shared/udp-over-tcp"],
  domain_resolver: ["dns/rule_action", "shared/dial"],
  http_client: ["shared/http-client", "shared/dial"],
  reality: ["shared/tls"],
  ech: ["shared/tls"],
  utls: ["shared/tls"],
  acme: ["shared/tls"],
  fakeip: ["dns/fakeip"],
};

const dnsServerDoc: Record<string, string> = { h3: "http3" };

/** The documents for the items of a section, by the item's type. */
export function sectionContexts(section: string, item?: Json): string[] {
  const type = item && typeof item === "object" && typeof item.type === "string" ? item.type : "";
  const docs = sectionDocs[section] ?? [];
  return docs.map((d) => d.replace("{type}", (section === "dns.servers" && dnsServerDoc[type]) || type)).filter((d) => !d.endsWith("/"));
}

/** The documents for a field's value: its definition's, else its key's, else the parent's. */
export function childContexts(parent: string[], key: string, node: Node | undefined): string[] {
  const name = defName(node);
  if (name && defDocs[name]) return defDocs[name];
  if (keyDocs[key]) return keyDocs[key];
  return parent;
}

export interface Found {
  doc?: FieldDoc;
  /** The document it was found in: a group such as shared/dial. */
  source?: string;
}

export function fieldDoc(contexts: string[], key: string): Found {
  for (const c of contexts) {
    const f = all[c]?.[key];
    if (f) return { doc: f, source: c };
  }
  const u = unique.get(key);
  return u ? { doc: u } : {};
}

/** Names of fields documented together, which the documentation cannot tell apart. */
const labels: Record<string, string> = {
  up_mbps: "上传带宽（Mbps）",
  down_mbps: "下载带宽（Mbps）",
  up: "上传带宽",
  down: "下载带宽",
  inet4_range: "IPv4 地址段",
  inet6_range: "IPv6 地址段",
  inet4_bind_address: "绑定的 IPv4 地址",
  inet6_bind_address: "绑定的 IPv6 地址",
};

/** A short name for a field: the first phrase of its description when short, else the key. */
export function fieldLabel(key: string, doc?: FieldDoc): string {
  if (labels[key]) return labels[key];
  const first = doc?.text?.split(/[。\n：:（(,，]/)[0]?.trim() ?? "";
  if (first && [...first].length <= 14 && !/[`*[\]]/.test(first) && !/^(参阅|See|如果|默认|仅|当|启用时)/.test(first)) return first;
  return key;
}

/** The documents of shared fields, as the editor groups them. */
export const groupNames: Record<string, string> = {
  "shared/dial": "拨号",
  "shared/listen": "监听",
  "shared/tls": "TLS",
  "shared/multiplex": "多路复用",
  "shared/v2ray-transport": "传输层",
  "shared/udp-over-tcp": "UDP over TCP",
  "shared/http-client": "HTTP 客户端",
  "shared/http2": "HTTP/2",
  "shared/quic": "QUIC",
  "dns/rule_action": "动作",
  "route/rule_action": "动作",
  inbound: "通用",
  outbound: "通用",
  endpoint: "通用",
  service: "通用",
};
