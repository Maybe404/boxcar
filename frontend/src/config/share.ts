// Share links of nodes, as other clients export them, read into outbounds:
// vless://, vmess://, trojan://, ss://, hysteria2:// (hy2://), tuic://,
// anytls://, hysteria://, socks://, http(s)://, naive+https://. A paste may
// hold many links, one per line, a base64 subscription of them, or
// outbounds as JSON.
import { stripJSONC } from "./jsonc";
import type { Json } from "./path";

export type ParsedLink = { ok: true; outbound: Json; line: string } | { ok: false; error: string; line: string };

/** base64, standard or URL-safe, padded or not, as UTF-8. */
export function decodeBase64(s: string): string {
  const clean = s.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new Error("base64 内容有误");
  }
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** A SHA-256 written in hex, colons or not, as base64. */
function hexToBase64(hex: string): string {
  const clean = hex.replace(/:/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("pinSHA256 不是 SHA-256 哈希");
  return btoa(String.fromCharCode(...clean.match(/../g)!.map((b) => parseInt(b, 16))));
}

const looksBase64 = (s: string) => /^[A-Za-z0-9+/=_-]+$/.test(s.replace(/\s/g, "")) && s.replace(/\s/g, "").length >= 8;

/** Percent-decodes a part of a link; a + is a +, as in a password. */
function dec(s: string | undefined): string {
  if (!s) return "";
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface Link {
  scheme: string;
  user: string;
  host: string;
  port: number;
  path: string;
  query: URLSearchParams;
  name: string;
}

const linkRe = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i;

function parseLink(line: string): Link | null {
  const m = linkRe.exec(line.trim());
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    user: m[2] ?? "",
    host: (m[3] ?? "").replace(/^\[|\]$/g, ""),
    port: m[4] ? Number(m[4]) : 0,
    path: m[5] ?? "",
    query: new URLSearchParams(m[6] ?? ""),
    name: dec(m[7]),
  };
}

const truthy = (v: string | null) => v === "1" || v === "true";

/** The TLS of a link's query: security=tls or reality, sni, fp, alpn, pbk, sid. */
function tlsOf(q: URLSearchParams, host: string, force = false): Json | undefined {
  const security = q.get("security") ?? (force ? "tls" : "");
  if (security !== "tls" && security !== "reality" && security !== "xtls") return undefined;
  const tls: Json = { enabled: true };
  const sni = q.get("sni") ?? q.get("peer") ?? q.get("host");
  tls.server_name = sni || host;
  if (truthy(q.get("allowInsecure")) || truthy(q.get("insecure")) || truthy(q.get("allow_insecure"))) tls.insecure = true;
  const alpn = q.get("alpn");
  if (alpn) tls.alpn = alpn.split(",").map((s) => s.trim()).filter(Boolean);
  const fp = q.get("fp");
  if (fp || security === "reality") tls.utls = { enabled: true, fingerprint: fp || "chrome" };
  if (security === "reality") {
    tls.reality = { enabled: true, public_key: q.get("pbk") ?? "" };
    if (q.get("sid")) tls.reality.short_id = q.get("sid");
  }
  return tls;
}

/** The V2Ray transport of a link: type=ws, grpc, http, httpupgrade, quic. */
function transportOf(net: string | null, host: string | null, path: string | null, service: string | null, header?: string | null): Json | undefined {
  // TCP with an HTTP header is obfuscation the core does not have.
  if (header && header !== "none") throw new Error(`还不支持 TCP 的 ${header} 伪装`);
  switch (net) {
    case "ws":
      return { type: "ws", ...(path ? { path } : {}), ...(host ? { headers: { Host: host } } : {}) };
    case "grpc":
      return { type: "grpc", ...(service || path ? { service_name: service || path } : {}) };
    case "http":
    case "h2":
      return { type: "http", ...(host ? { host: host.split(",") } : {}), ...(path ? { path } : {}) };
    case "httpupgrade":
      return { type: "httpupgrade", ...(host ? { host } : {}), ...(path ? { path } : {}) };
    case "quic":
      return { type: "quic" };
    case null:
    case "":
    case "tcp":
    case "raw":
    case "none":
      return undefined;
  }
  // Imported without it, the node would silently try plain TCP.
  throw new Error(`还不支持 ${net} 传输`);
}

function base(type: string, l: Link, defaultName: string): Json {
  if (!l.host) throw new Error("没有服务器地址");
  if (!l.port) throw new Error("没有端口");
  return { type, tag: l.name || defaultName || `${l.host}:${l.port}`, server: l.host, server_port: l.port };
}

function userPass(user: string): [string, string] {
  const raw = dec(user);
  const i = raw.indexOf(":");
  return i < 0 ? [raw, ""] : [raw.slice(0, i), raw.slice(i + 1)];
}

function vmess(body: string): Json {
  const v = JSON.parse(decodeBase64(body));
  const port = Number(v.port);
  if (!v.add || !port) throw new Error("vmess 链接里没有地址或端口");
  const out: Json = { type: "vmess", tag: v.ps || `${v.add}:${port}`, server: v.add, server_port: port, uuid: v.id, security: v.scy || "auto" };
  if (Number(v.aid)) out.alter_id = Number(v.aid);
  if (v.tls === "tls") {
    out.tls = { enabled: true, server_name: v.sni || v.host || v.add };
    if (v.alpn) out.tls.alpn = String(v.alpn).split(",");
    if (v.fp) out.tls.utls = { enabled: true, fingerprint: v.fp };
    if (truthy(String(v.allowInsecure ?? v.insecure ?? ""))) out.tls.insecure = true;
  }
  const transport = transportOf(v.net, v.host || null, v.path || null, v.path || null, ["", "tcp", "raw", undefined].includes(v.net) ? v.type : null);
  if (transport) out.transport = transport;
  return out;
}

function shadowsocks(l: Link, raw: string): Json {
  let method: string;
  let password: string;
  let link = l;
  if (!l.user) {
    // ss://BASE64(method:password@host:port)#name
    const hash = raw.indexOf("#");
    const body = raw.slice("ss://".length, hash < 0 ? undefined : hash);
    const decoded = decodeBase64(body.split("?")[0].replace(/\/$/, ""));
    // The password may hold an @: the server follows the last one.
    const at = decoded.lastIndexOf("@");
    if (at < 0) throw new Error("无法识别的 ss 链接");
    const again = parseLink(`ss://${encodeURIComponent(decoded.slice(0, at))}@${decoded.slice(at + 1)}${hash < 0 ? "" : raw.slice(hash)}`);
    if (!again?.user) throw new Error("无法识别的 ss 链接");
    link = again;
    [method, password] = userPass(again.user);
  } else {
    const user = dec(l.user);
    [method, password] = user.includes(":") ? userPass(l.user) : userPass(encodeURIComponent(decodeBase64(user)));
  }
  const out = base("shadowsocks", link, "");
  out.method = method;
  out.password = password;
  const plugin = link.query.get("plugin");
  if (plugin) {
    const [name, ...opts] = plugin.split(";");
    out.plugin = name === "simple-obfs" ? "obfs-local" : name;
    if (opts.length) out.plugin_opts = opts.join(";");
  }
  return out;
}

/** Reads one link. */
export function parseShareLink(line: string): ParsedLink {
  const text = line.trim();
  try {
    const scheme = text.slice(0, text.indexOf("://")).toLowerCase();
    if (scheme === "vmess") return { ok: true, outbound: vmess(text.slice("vmess://".length).split("#")[0]), line };
    const l = parseLink(text);
    if (!l) throw new Error("不是可识别的链接");
    const q = l.query;
    switch (l.scheme) {
      case "vless": {
        const out = base("vless", l, "");
        out.uuid = dec(l.user);
        const encryption = q.get("encryption");
        if (encryption && encryption !== "none") throw new Error("还不支持 VLESS 加密（encryption）");
        if (q.get("flow")) out.flow = q.get("flow");
        if (q.get("packetEncoding")) out.packet_encoding = q.get("packetEncoding");
        const tls = tlsOf(q, l.host);
        if (tls) out.tls = tls;
        const transport = transportOf(q.get("type"), q.get("host"), q.get("path"), q.get("serviceName"), q.get("headerType"));
        if (transport) out.transport = transport;
        return { ok: true, outbound: out, line };
      }
      case "trojan": {
        const out = base("trojan", l, "");
        out.password = dec(l.user);
        out.tls = tlsOf(q, l.host, true);
        const transport = transportOf(q.get("type"), q.get("host"), q.get("path"), q.get("serviceName"), q.get("headerType"));
        if (transport) out.transport = transport;
        return { ok: true, outbound: out, line };
      }
      case "ss":
        return { ok: true, outbound: shadowsocks(l, text), line };
      case "hysteria2":
      case "hy2": {
        const out = base("hysteria2", l, "");
        if (l.user) out.password = dec(l.user);
        out.tls = tlsOf(q, l.host, true);
        const obfs = q.get("obfs");
        if (obfs) out.obfs = { type: obfs, password: q.get("obfs-password") ?? "" };
        const ports = q.get("mport");
        if (ports) out.server_ports = ports.split(",").map((p) => p.replace("-", ":"));
        if (q.get("upmbps")) out.up_mbps = Number(q.get("upmbps"));
        if (q.get("downmbps")) out.down_mbps = Number(q.get("downmbps"));
        const pin = q.get("pinSHA256");
        if (pin) out.tls.certificate_sha256 = [hexToBase64(pin)];
        return { ok: true, outbound: out, line };
      }
      case "tuic": {
        const out = base("tuic", l, "");
        const [uuid, password] = userPass(l.user);
        out.uuid = uuid;
        if (password) out.password = password;
        if (q.get("congestion_control")) out.congestion_control = q.get("congestion_control");
        if (q.get("udp_relay_mode")) out.udp_relay_mode = q.get("udp_relay_mode");
        out.tls = tlsOf(q, l.host, true);
        return { ok: true, outbound: out, line };
      }
      case "anytls": {
        const out = base("anytls", l, "");
        out.password = dec(l.user);
        out.tls = tlsOf(q, l.host, true);
        return { ok: true, outbound: out, line };
      }
      case "hysteria": {
        const out = base("hysteria", l, "");
        if (q.get("auth")) out.auth_str = q.get("auth");
        out.up_mbps = Number(q.get("upmbps") ?? 0) || 10;
        out.down_mbps = Number(q.get("downmbps") ?? 0) || 50;
        if (q.get("obfsParam") || q.get("obfs")) out.obfs = q.get("obfsParam") || q.get("obfs");
        out.tls = tlsOf(q, l.host, true);
        return { ok: true, outbound: out, line };
      }
      case "socks":
      case "socks5":
      case "socks4": {
        const out = base("socks", l, "");
        if (l.scheme === "socks4") out.version = "4";
        if (l.user) {
          const user = dec(l.user);
          const [u, p] = user.includes(":") || !looksBase64(user) ? userPass(l.user) : userPass(encodeURIComponent(decodeBase64(user)));
          if (u) out.username = u;
          if (p) out.password = p;
        }
        return { ok: true, outbound: out, line };
      }
      case "http":
      case "https": {
        const out = base("http", { ...l, port: l.port || (l.scheme === "https" ? 443 : 80) }, "");
        const [u, p] = userPass(l.user);
        if (u) out.username = u;
        if (p) out.password = p;
        if (l.scheme === "https") out.tls = { enabled: true, server_name: l.host };
        return { ok: true, outbound: out, line };
      }
      case "naive+https":
      case "naive+quic": {
        const out = base("naive", { ...l, port: l.port || 443 }, "");
        const [u, p] = userPass(l.user);
        if (u) out.username = u;
        if (p) out.password = p;
        out.tls = { enabled: true, server_name: l.host };
        if (l.scheme === "naive+quic") out.quic = true;
        return { ok: true, outbound: out, line };
      }
    }
    throw new Error(`还不支持 ${l.scheme}:// 链接`);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), line };
  }
}

/** Reads what was pasted: links, a base64 subscription of them, or outbounds as JSON. */
export function parseShareText(text: string): ParsedLink[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const v = JSON.parse(stripJSONC(t));
      const list: Json[] = Array.isArray(v) ? v : Array.isArray(v.outbounds) ? v.outbounds : [v];
      return list.map((o) => (o && typeof o === "object" && typeof o.type === "string" ? { ok: true, outbound: o, line: o.tag ?? o.type } : { ok: false, error: "不是出站", line: JSON.stringify(o).slice(0, 60) }));
    } catch (err) {
      return [{ ok: false, error: `JSON 有误：${err instanceof Error ? err.message : String(err)}`, line: t.slice(0, 60) }];
    }
  }
  let body = t;
  if (!t.includes("://") && looksBase64(t)) {
    try {
      const decoded = decodeBase64(t);
      if (decoded.includes("://")) body = decoded;
    } catch {
      // Not base64 after all.
    }
  }
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseShareLink);
}
