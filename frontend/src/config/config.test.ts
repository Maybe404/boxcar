// The editor's model, without the page: bun test, in frontend/.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import examples from "./gen/examples.json";
import { hasComments, parseConfig, stringifyConfig, stripJSONC } from "./jsonc";
import { choiceIndex, def, isObjectish, isTextItems, itemVariants, newVariantItem, objectShape, resolve, schema, shapeOf, type Node } from "./schema";
import { checkRefs, findRefs, refsTo, renameRefs, tagsOf } from "./refs";
import { addItem, dnsTemplates, enableFakeIP, disableFakeIP, removeItem, replaceItem, routeTemplates, uniqueTag } from "./ops";
import { parseShareLink, parseShareText } from "./share";
import { describeRule } from "./describe";
import { fieldDoc, sectionContexts } from "./docs";
import { getIn, isObject, setIn, type Json } from "./path";

describe("jsonc", () => {
  test("comments and trailing commas go, strings stay", () => {
    const text = `{
  // a comment
  "url": "https://example.com/a//b", /* block */
  "list": [1, 2,],
}`;
    expect(JSON.parse(stripJSONC(text))).toEqual({ url: "https://example.com/a//b", list: [1, 2] });
    expect(hasComments(text)).toBe(true);
    expect(hasComments(`{"url": "https://x//y"}`)).toBe(false);
  });
  test("the top must be an object", () => {
    expect(parseConfig("[]").ok).toBe(false);
    expect(parseConfig("").ok).toBe(true);
  });
});

/**
 * Walks a value the way the form does: every object through the fields
 * objectShape gives it, every list item by item; and writes it back as an
 * edit of each field to the value it has. Returns what the form could not
 * place.
 */
function openAndSave(node: Node | undefined, value: Json, path: string, unknown: string[]): Json {
  if (!node) return value;
  const shape = shapeOf(node);
  switch (shape.kind) {
    case "object": {
      if (!isObject(value)) return value;
      const s = objectShape(shape.node, value);
      const props = new Map(s.props);
      const discs = new Set(s.discriminators.map((d) => d.key));
      let out: Json = value;
      for (const k of Object.keys(value)) {
        let child = value[k];
        if (props.has(k)) child = openAndSave(props.get(k), value[k], `${path}.${k}`, unknown);
        else if (s.map) child = openAndSave(s.map, value[k], `${path}.${k}`, unknown);
        else if (!discs.has(k)) unknown.push(`${path}.${k}`);
        // As ObjectFields sets a field.
        out = { ...out, [k]: child };
      }
      return out;
    }
    case "array":
      return Array.isArray(value) ? value.map((v, i) => openAndSave(shape.items, v, `${path}[${i}]`, unknown)) : value;
    case "listable":
      return Array.isArray(value) ? value.map((v, i) => openAndSave(shape.item, v, `${path}[${i}]`, unknown)) : openAndSave(shape.item, value, path, unknown);
    case "choice":
      return openAndSave(shape.options[choiceIndex(shape.options, value)], value, path, unknown);
    default:
      return value;
  }
}

describe("the documentation's examples", () => {
  test("there are examples", () => {
    expect(examples.length).toBeGreaterThan(50);
  });
  test("open and save in the form, unchanged", () => {
    const unknownBySource: Record<string, string[]> = {};
    for (const ex of examples as { source: string; config: Json }[]) {
      const unknown: string[] = [];
      const text = stringifyConfig(ex.config);
      const parsed = parseConfig(text);
      expect(parsed.ok).toBe(true);
      const saved = openAndSave(schema, parsed.ok ? parsed.value : {}, "", unknown);
      // The same text: the same keys, in the same order, with the same values.
      expect(stringifyConfig(saved)).toBe(text);
      if (unknown.length) unknownBySource[ex.source] = unknown;
    }
    // Everything the form does not know is kept as it is (above). Old
    // examples still show fields the core has removed since, and the pages
    // of deprecated formats (legacy DNS servers, migration) show those;
    // nothing else is unknown to the form.
    const removed = new Set(["geoip", "geosite", "source_geoip", "independent_cache", "fakeip", "outbound", "rule_set_ipcidr_match_source", "rule_set_ip_cidr_accept_empty", "store_rdrc", "acme"]);
    const unexpected = Object.entries(unknownBySource)
      .filter(([source]) => !/legacy|migration/.test(source))
      .flatMap(([source, paths]) => paths.filter((p) => !removed.has(p.split(".").pop()!)).map((p) => `${source}: ${p}`));
    expect(unexpected).toEqual([]);
  });
  test("references are found without errors", () => {
    for (const ex of examples as { config: Json }[]) expect(() => checkRefs(ex.config)).not.toThrow();
  });
});

describe("every part of the schema has a form", () => {
  test("every section of the configuration", () => {
    for (const [k, node] of Object.entries(schema.properties as Record<string, Node>)) {
      if (k === "$schema") continue;
      const kind = shapeOf(node).kind;
      expect([k, kind]).toEqual([k, expect.stringMatching(/^(object|array)$/)]);
    }
  });
  test("every type of every list of things", () => {
    for (const name of ["Inbound", "Outbound", "Endpoint", "DNSServer", "Service", "RuleSet", "CertificateProvider", "V2RayTransport", "NetworkNamespace"]) {
      const items = def(name);
      const disc = itemVariants(items);
      expect(disc).toBeDefined();
      for (const v of disc!.variants) {
        const item = newVariantItem(items, v.value);
        const shape = objectShape(items, item);
        expect([name, shape.discriminators[0].current]).toEqual([name, v.value]);
      }
    }
  });
  test("every action of rules", () => {
    for (const [name, node] of [
      ["Rule", def("Rule")],
      ["DNSRule", def("DNSRule")],
    ] as const) {
      const actions = objectShape(node, {}).discriminators.find((d) => d.key === "action")!;
      expect(actions.variants.length).toBeGreaterThan(4);
      for (const v of actions.variants) {
        const shape = objectShape(node, { action: v.value });
        expect([name, shape.discriminators.find((d) => d.key === "action")!.current]).toEqual([name, v.value]);
      }
      const logical = objectShape(node, { type: "logical", mode: "and", rules: [] });
      expect(logical.props.map(([k]) => k)).toContain("rules");
    }
  });
  test("fields have Chinese descriptions", () => {
    const vless = sectionContexts("outbounds", { type: "vless" });
    expect(fieldDoc(vless, "uuid").doc?.text).toContain("VLESS");
    expect(fieldDoc(vless, "detour").source).toBe("shared/dial");
    expect(fieldDoc(sectionContexts("dns.servers", { type: "h3" }), "server").source).toBe("dns/server/http3");
  });
  test("objects of a choice are objects", () => {
    expect(isObjectish(resolve(def("Outbound")))).toBe(true);
    expect(shapeOf(def("DomainResolver")).kind).toBe("choice");
  });

  test("lists of objects are not edited as text", () => {
    const props = (d: string, type: string, key: string) => (def(d).oneOf as Node[]).map(resolve).find((b) => b.properties?.type?.const === type)?.properties?.[key];
    const items = (n: Node) => {
      const s = shapeOf(n) as { item?: Node; items?: Node };
      return (s.item ?? s.items)!;
    };
    expect(isTextItems(items(props("Service", "derp", "mesh_with")))).toBe(false);
    expect(isTextItems(items(props("Service", "derp", "verify_client_url")))).toBe(false);
    expect(isTextItems(items(props("Outbound", "tailcat", "derp_servers")))).toBe(false);
    expect(isTextItems(items(resolve(def("OutboundTLSOptions")).properties.certificate_sha256))).toBe(true);
  });
});

const base = {
  inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }],
  outbounds: [
    { type: "selector", tag: "proxy", outbounds: ["a", "b"] },
    { type: "vless", tag: "a", server: "a.example.com", server_port: 443, uuid: "00000000-0000-4000-8000-000000000001" },
    { type: "trojan", tag: "b", server: "b.example.com", server_port: 443, password: "x", detour: "a" },
    { type: "direct", tag: "direct" },
  ],
  route: { rules: [{ inbound: "mixed-in", outbound: "a" }], final: "proxy" },
};

describe("references", () => {
  test("as the check finds them", () => {
    expect(checkRefs(base)).toEqual([]);
    const broken = setIn(base, ["route", "final"], "gone");
    expect(checkRefs(broken)).toEqual([{ path: "route.final", message: "引用的出站“gone”不存在", fatal: true }]);
    expect(checkRefs(setIn(base, ["outbounds", 3, "tag"], "a"))[0].message).toContain("重复");
  });
  test("renaming a node renames it everywhere", () => {
    const next = replaceItem(base, ["outbounds"], 1, { ...base.outbounds[1], tag: "香港" });
    expect(getIn(next, ["outbounds", 0, "outbounds"])).toEqual(["香港", "b"]);
    expect(getIn(next, ["outbounds", 2, "detour"])).toBe("香港");
    expect(getIn(next, ["route", "rules", 0, "outbound"])).toBe("香港");
    expect(checkRefs(next)).toEqual([]);
  });
  test("removing a node takes it out of groups, and leaves single references to fix", () => {
    expect(refsTo(base, "outbound", "a").length).toBe(3);
    const next = removeItem(base, ["outbounds"], 1);
    expect(getIn(next, ["outbounds", 0, "outbounds"])).toEqual(["b"]);
    expect(checkRefs(next).map((p) => p.path)).toEqual(["outbounds[1].detour", "route.rules[0].outbound"]);
  });
  test("a list a deletion would leave empty keeps the reference, for the check to show", () => {
    const c = {
      route: {
        rules: [{ rule_set: ["cn"], action: "route", outbound: "direct" }, { rule_set: ["cn", "ads"], action: "reject" }],
        rule_set: [{ type: "local", tag: "cn", path: "cn.srs" }, { type: "local", tag: "ads", path: "ads.srs" }],
      },
      outbounds: [{ type: "direct", tag: "direct" }],
    };
    const next = removeItem(c, ["route", "rule_set"], 0);
    // Not rule_set: [], which would match everything.
    expect(getIn(next, ["route", "rules", 0, "rule_set"])).toEqual(["cn"]);
    expect(getIn(next, ["route", "rules", 1, "rule_set"])).toEqual(["ads"]);
    expect(checkRefs(next).map((p) => [p.path, p.fatal])).toEqual([["route.rules[0].rule_set[0]", true]]);
  });
  test("endpoints are not outbounds: direct is still added, unless final is an endpoint", () => {
    const wg = { endpoints: [{ type: "wireguard", tag: "wg" }], route: { rules: [{ outbound: "direct" }] } };
    expect(checkRefs(wg)).toEqual([]);
    expect(checkRefs(setIn(wg, ["route", "final"], "wg"))).toMatchObject([{ path: "route.rules[0].outbound", fatal: true }]);
  });
  test("removing the last item leaves an empty configuration, not none", () => {
    expect(removeItem({ inbounds: [{ type: "mixed", tag: "in" }] }, ["inbounds"], 0)).toEqual({});
    expect(removeItem({ outbounds: [{ type: "direct", tag: "d" }] }, ["outbounds"], 0)).toEqual({});
    expect(removeItem({ dns: { servers: [{ type: "local", tag: "l" }] } }, ["dns", "servers"], 0)).toEqual({});
  });
  test("a missing inbound is not fatal", () => {
    expect(checkRefs(setIn(base, ["route", "rules", 0, "inbound"], "nope"))).toMatchObject([{ path: "route.rules[0].inbound", fatal: false }]);
  });
  test("renaming refs of one kind leaves the others", () => {
    const next = renameRefs(base, "inbound", "mixed-in", "in");
    expect(getIn(next, ["route", "rules", 0, "inbound"])).toBe("in");
    expect(findRefs(next).filter((r) => r.kind === "outbound").length).toBe(findRefs(base).filter((r) => r.kind === "outbound").length);
  });
});

describe("share links", () => {
  test("vless with reality and grpc", () => {
    const r = parseShareLink("vless://11111111-2222-4333-8444-555555555555@hk.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=PUBKEY&sid=ab12&type=grpc&serviceName=svc#%E9%A6%99%E6%B8%AF");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outbound).toEqual({
      type: "vless",
      tag: "香港",
      server: "hk.example.com",
      server_port: 443,
      uuid: "11111111-2222-4333-8444-555555555555",
      flow: "xtls-rprx-vision",
      tls: { enabled: true, server_name: "www.apple.com", utls: { enabled: true, fingerprint: "chrome" }, reality: { enabled: true, public_key: "PUBKEY", short_id: "ab12" } },
      transport: { type: "grpc", service_name: "svc" },
    });
  });
  test("vmess", () => {
    const body = btoa(JSON.stringify({ v: "2", ps: "jp", add: "jp.example.com", port: "8443", id: "u", aid: "0", net: "ws", host: "cdn.example.com", path: "/ws", tls: "tls", sni: "cdn.example.com" }));
    const r = parseShareLink(`vmess://${body}`);
    expect(r.ok && r.outbound).toEqual({
      type: "vmess",
      tag: "jp",
      server: "jp.example.com",
      server_port: 8443,
      uuid: "u",
      security: "auto",
      tls: { enabled: true, server_name: "cdn.example.com" },
      transport: { type: "ws", path: "/ws", headers: { Host: "cdn.example.com" } },
    });
  });
  test("shadowsocks, both forms", () => {
    const sip002 = parseShareLink(`ss://${btoa("aes-256-gcm:pass")}@ss.example.com:8388/?plugin=obfs-local%3Bobfs%3Dhttp#ss`);
    expect(sip002.ok && sip002.outbound).toEqual({ type: "shadowsocks", tag: "ss", server: "ss.example.com", server_port: 8388, method: "aes-256-gcm", password: "pass", plugin: "obfs-local", plugin_opts: "obfs=http" });
    const legacy = parseShareLink(`ss://${btoa("chacha20-ietf-poly1305:p@ss@1.2.3.4:443")}#old`);
    expect(legacy.ok && legacy.outbound).toMatchObject({ server: "1.2.3.4", server_port: 443, method: "chacha20-ietf-poly1305", password: "p@ss", tag: "old" });
    const plain = parseShareLink("ss://2022-blake3-aes-128-gcm:a%2Bb@s.example.com:443#n");
    expect(plain.ok && plain.outbound).toMatchObject({ method: "2022-blake3-aes-128-gcm", password: "a+b" });
  });
  test("trojan, hysteria2, tuic, anytls", () => {
    expect(parseShareLink("trojan://pw@t.example.com:443?sni=t.example.com&type=ws&path=%2Fp#t")).toMatchObject({ ok: true, outbound: { type: "trojan", password: "pw", tls: { enabled: true, server_name: "t.example.com" }, transport: { type: "ws", path: "/p" } } });
    expect(parseShareLink("hy2://auth@h.example.com:443?insecure=1&obfs=salamander&obfs-password=o#h")).toMatchObject({ ok: true, outbound: { type: "hysteria2", password: "auth", tls: { enabled: true, insecure: true, server_name: "h.example.com" }, obfs: { type: "salamander", password: "o" } } });
    expect(parseShareLink("tuic://uuid:pw@u.example.com:443?congestion_control=bbr&alpn=h3#u")).toMatchObject({ ok: true, outbound: { type: "tuic", uuid: "uuid", password: "pw", congestion_control: "bbr", tls: { alpn: ["h3"] } } });
    expect(parseShareLink("anytls://pw@a.example.com:443#a")).toMatchObject({ ok: true, outbound: { type: "anytls", password: "pw", tls: { enabled: true } } });
  });
  test("a + in a password is a +", () => {
    expect(parseShareLink("trojan://pa+ss@t.example.com:443#t")).toMatchObject({ ok: true, outbound: { password: "pa+ss" } });
    expect(parseShareLink(`ss://${btoa("aes-256-gcm:pa>>?ss")}@1.2.3.4:8388#s`)).toMatchObject({ ok: true, outbound: { method: "aes-256-gcm", password: "pa>>?ss" } });
    expect(parseShareLink("ss://2022-blake3-aes-128-gcm:abc+def==@s.example.com:443#n")).toMatchObject({ ok: true, outbound: { password: "abc+def==" } });
  });
  test("a transport not supported is an error, not plain TCP", () => {
    expect(parseShareLink("vless://u@h.example.com:443?type=xhttp#x").ok).toBe(false);
    expect(parseShareLink("vless://u@h.example.com:443?type=tcp#x").ok).toBe(true);
    // HTTP obfuscation over TCP, and VLESS encryption, the core does not have.
    expect(parseShareLink("vless://u@h.example.com:443?type=tcp&headerType=http#x").ok).toBe(false);
    expect(parseShareLink("vless://u@h.example.com:443?encryption=mlkem768x25519plus.native.0rtt.abc#x").ok).toBe(false);
    const vmess = (v: object) => parseShareLink(`vmess://${btoa(JSON.stringify({ add: "h.example.com", port: 443, id: "u", net: "tcp", ...v }))}`);
    expect(vmess({ type: "http" }).ok).toBe(false);
    expect(vmess({ type: "none" }).ok).toBe(true);
  });
  test("hysteria2 with a pinned certificate", () => {
    const pin = "AB:".repeat(31) + "AB";
    const r = parseShareLink(`hy2://p@h.example.com:443?pinSHA256=${pin}#x`);
    expect(r.ok && r.outbound.tls.certificate_sha256).toEqual([btoa(String.fromCharCode(...Array(32).fill(0xab)))]);
    expect(parseShareLink("hy2://p@h.example.com:443?pinSHA256=xyz#x").ok).toBe(false);
  });
  test("broken links say what is wrong, in Chinese", () => {
    expect(parseShareLink(`ss://${btoa("aes-128-gcm:pass")}#x`)).toMatchObject({ ok: false, error: "无法识别的 ss 链接" });
    expect(parseShareLink("vmess://@@@")).toMatchObject({ ok: false, error: "base64 内容有误" });
    // Text that only looks like base64 is read as it is.
    expect(parseShareText("hello-world-123")).toMatchObject([{ ok: false, line: "hello-world-123" }]);
  });
  test("a base64 subscription, outbounds as JSON, and errors", () => {
    const sub = btoa("trojan://a@x.example.com:443#x\nhy2://b@y.example.com:443#y");
    expect(parseShareText(sub).map((r) => r.ok && r.outbound.tag)).toEqual(["x", "y"]);
    expect(parseShareText(`[{"type": "direct", "tag": "d"}]`)).toMatchObject([{ ok: true, outbound: { type: "direct" } }]);
    expect(parseShareText("wireguard://x").every((r) => !r.ok)).toBe(true);
    expect(parseShareText("vless://u@host#noport")[0].ok).toBe(false);
  });
});

describe("rules in words", () => {
  test("alternatives of the destination, and the rest", () => {
    expect(describeRule({ domain_suffix: ["a.com", "b.com"], rule_set: "cn", port: 443, outbound: "proxy" })).toEqual({
      match: "（域名后缀是 a.com 或 b.com 或 属于规则集 cn），且目标端口是 443",
      action: "走 proxy",
    });
    expect(describeRule({ ip_is_private: true, action: "route", outbound: "direct" }).match).toBe("目标是局域网 IP");
    expect(describeRule({ action: "sniff" }).match).toBe("所有流量");
    expect(describeRule({ protocol: "dns", action: "hijack-dns" }).action).toBe("交给内置 DNS");
  });
  test("logical rules and inversion", () => {
    const r = { type: "logical", mode: "or", rules: [{ domain: "x.com" }, { port: [80, 443] }], invert: true, action: "reject" };
    expect(describeRule(r)).toEqual({ match: "不满足［满足任一：域名是 x.com；目标端口是 80 或 443］时", action: "拒绝" });
  });
  test("DNS rules: the server is the action", () => {
    expect(describeRule({ query_type: ["A", "AAAA"], server: "fakeip" }, "dns")).toEqual({ match: "查询类型是 A 或 AAAA", action: "用 fakeip 查询" });
    expect(describeRule({ rule_set: "geosite-category-ads-all", action: "reject" }, "dns").action).toBe("拒绝查询");
  });
});

/** Compares with a golden file in testdata/wizard, which the Go tests check with the core. */
function golden(name: string, config: Json) {
  const path = new URL(`../../../testdata/wizard/${name}.json`, import.meta.url).pathname;
  const text = stringifyConfig(config);
  if (process.env.UPDATE) writeFileSync(path, text);
  // A missing golden file fails, so that a deleted one is noticed: UPDATE=1 writes it.
  expect(existsSync(path)).toBe(true);
  expect(text).toBe(readFileSync(path, "utf8"));
}

/** A local port, two nodes from links, and a group, only through the wizards' changes. */
function portNodesGroup(): Json {
  let c: Json = {};
  // 本地端口: the dialog's default.
  c = addItem(c, ["inbounds"], { type: "mixed", tag: uniqueTag(c, "inbound", "mixed-in"), listen: "127.0.0.1", listen_port: 2080 });
  // 节点: pasted links.
  const tags: string[] = [];
  for (const r of parseShareText("vless://00000000-0000-4000-8000-000000000001@hk.example.com:443?security=tls&sni=hk.example.com#香港\nhy2://secret@jp.example.com:443#日本")) {
    if (!r.ok) throw new Error(r.error);
    const tag = uniqueTag(c, "outbound", r.outbound.tag);
    c = addItem(c, ["outbounds"], { ...r.outbound, tag });
    tags.push(tag);
  }
  // 策略组: a selector of both, the default outbound.
  c = addItem(c, ["outbounds"], { type: "selector", tag: uniqueTag(c, "outbound", "proxy"), outbounds: tags });
  c = setIn(c, ["route", "final"], "proxy");
  return c;
}

describe("the wizards alone", () => {
  test("a local port, two nodes and a group, from nothing", () => {
    const c = portNodesGroup();
    expect(checkRefs(c)).toEqual([]);
    expect(tagsOf(c, "outbound")).toEqual(["香港", "日本", "proxy"]);
    golden("port-nodes-group", c);
  });
  test("China direct, the rest proxied, ads blocked, with DNS to match", () => {
    let c = portNodesGroup();
    for (const t of routeTemplates) c = t.apply(c);
    for (const t of dnsTemplates) c = t.apply(c);
    expect(checkRefs(c)).toEqual([]);
    // Applying again changes nothing.
    let again = c;
    for (const t of [...routeTemplates, ...dnsTemplates]) again = t.apply(again);
    expect(again).toEqual(c);
    expect(getIn(c, ["route", "rules"]).map((r: Json) => describeRule(r))).toEqual([
      { match: "所有流量", action: "探测协议" },
      { match: "协议是 dns", action: "交给内置 DNS" },
      { match: "属于规则集 geosite-category-ads-all", action: "拒绝" },
      { match: "目标是局域网 IP", action: "走 direct" },
      { match: "属于规则集 geosite-cn 或 geoip-cn", action: "走 direct" },
    ]);
    golden("cn-direct-ads-dns", c);
  });
  test("FakeIP on and off", () => {
    const on = enableFakeIP(portNodesGroup());
    expect(checkRefs(on)).toEqual([]);
    expect(getIn(on, ["dns", "rules", 0, "server"])).toBe("fakeip");
    // Not the default: the core refuses that; the system's DNS is.
    expect(getIn(on, ["dns", "final"])).toBe("dns-local");
    golden("fakeip", on);
    const off = disableFakeIP(on);
    expect(getIn(off, ["dns", "servers"])).toEqual([{ type: "local", tag: "dns-local" }]);
    expect(getIn(on, ["route", "default_domain_resolver"])).toBe("dns-local");
    expect(checkRefs(off)).toEqual([]);
  });
  test("templates use the direct outbound there is, untagged too", () => {
    const c = routeTemplates.find((t) => t.id === "lan-direct")!.apply({ outbounds: [{ type: "selector", tag: "proxy", outbounds: ["1"] }, { type: "direct" }] });
    expect(getIn(c, ["route", "rules", 0, "outbound"])).toBe("1");
    expect(checkRefs(c)).toEqual([]);
  });
});
