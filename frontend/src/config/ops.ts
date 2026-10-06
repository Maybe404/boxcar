// Changes the wizards make to a configuration: each takes one and returns
// a new one, with every reference kept in step.
import { getIn, isObject, setIn, type Json, type Path } from "./path";
import { removeListRefs, renameRefs, tagSections, tagsOf, tagsOfItem, type TagKind } from "./refs";

export const groupTypes = new Set(["selector", "urltest"]);

/** Outbounds that only route: no server of their own. */
export const builtinTypes = new Set(["direct", "block", "dns"]);

export const isGroup = (o: Json) => isObject(o) && groupTypes.has(o.type);

/** A tag not taken among the kind's: base, base 2, base 3… */
export function uniqueTag(config: Json, kind: TagKind, base: string, except?: string): string {
  const taken = new Set(tagsOf(config, kind).filter((t) => t !== except));
  const clean = base.trim() || "新";
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} ${i}`)) return `${clean} ${i}`;
}

/** The kinds of tags the items of a section define. */
export function kindsOf(section: Path): TagKind[] {
  const key = section.join(".");
  return tagSections.find((s) => s.path.join(".") === key)?.kinds ?? [];
}

/** The items of a section, an empty list for none. */
export function itemsOf(config: Json, section: Path): Json[] {
  const v = getIn(config, section);
  return Array.isArray(v) ? v : [];
}

/** Appends an item to a section. */
export function addItem(config: Json, section: Path, item: Json): Json {
  return setIn(config, section, [...itemsOf(config, section), item]);
}

/** Replaces the item at an index, renaming the references when its tag changed. */
export function replaceItem(config: Json, section: Path, index: number, item: Json): Json {
  const old = itemsOf(config, section)[index];
  let next = setIn(config, [...section, index], item);
  const from = old ? tagsOfItem(old, index)[0] : undefined;
  const to = tagsOfItem(item, index)[0];
  if (from !== undefined && from !== to) for (const kind of kindsOf(section)) next = renameRefs(next, kind, from, to);
  return next;
}

/** Removes the item at an index, and its tag from the lists that name it, as a group's members. */
export function removeItem(config: Json, section: Path, index: number): Json {
  const items = itemsOf(config, section);
  const tags = items[index] ? tagsOfItem(items[index], index) : [];
  let next = setIn(config, [...section, index], undefined);
  if (itemsOf(next, section).length === 0) next = pruneEmpty(setIn(next, section, undefined), section.slice(0, -1));
  for (const kind of kindsOf(section)) for (const tag of tags) next = removeListRefs(next, kind, tag);
  return next;
}

/** Copies the item at an index after it, under a new tag. */
export function duplicateItem(config: Json, section: Path, index: number, kind: TagKind): Json {
  const items = itemsOf(config, section);
  const item = structuredClone(items[index]);
  if (isObject(item)) item.tag = uniqueTag(config, kind, `${item.tag ?? item.type ?? ""} 副本`);
  return setIn(config, section, [...items.slice(0, index + 1), item, ...items.slice(index + 1)]);
}

/** The tag of the direct outbound, added when there is none. */
export function ensureDirect(config: Json): [Json, string] {
  const outbounds = itemsOf(config, ["outbounds"]);
  const i = outbounds.findIndex((o) => isObject(o) && o.type === "direct");
  // Untagged, it is named by its index.
  if (i >= 0) return [config, tagsOfItem(outbounds[i], i)[0]];
  const tag = uniqueTag(config, "outbound", "direct");
  return [addItem(config, ["outbounds"], { type: "direct", tag }), tag];
}

/** Where rule sets are downloaded from. */
export const ruleSetBase = {
  geosite: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set",
  geoip: "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set",
};

/** Common remote rule sets, by tag. */
export const commonRuleSets: Record<string, { url: string; name: string }> = {
  "geosite-cn": { url: `${ruleSetBase.geosite}/geosite-cn.srs`, name: "中国大陆常见域名" },
  "geoip-cn": { url: `${ruleSetBase.geoip}/geoip-cn.srs`, name: "中国大陆 IP" },
  "geosite-geolocation-!cn": { url: `${ruleSetBase.geosite}/geosite-geolocation-!cn.srs`, name: "中国大陆以外的常见域名" },
  "geosite-category-ads-all": { url: `${ruleSetBase.geosite}/geosite-category-ads-all.srs`, name: "广告域名" },
  "geosite-private": { url: `${ruleSetBase.geosite}/geosite-private.srs`, name: "局域网与私有域名" },
};

/**
 * A remote rule set of the common ones, added unless there. It downloads
 * through the default outbound, as the core did before HTTP clients.
 */
export function ensureRuleSet(config: Json, tag: string): Json {
  if (tagsOf(config, "rule_set").includes(tag)) return config;
  const common = commonRuleSets[tag];
  if (!common) return config;
  const set: Json = { type: "remote", tag, format: "binary", url: common.url };
  const final = getIn(config, ["route", "final"]);
  if (typeof final === "string" && final) set.http_client = { detour: final };
  return addItem(config, ["route", "rule_set"], set);
}

/** The index after the rules that sniff and hijack DNS, where blocking rules go. */
function afterPrelude(rules: Json[]): number {
  let i = 0;
  while (i < rules.length && isObject(rules[i]) && (rules[i].action === "sniff" || rules[i].action === "hijack-dns")) i++;
  return i;
}

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

function insertRule(config: Json, path: Path, rule: Json, at: number | "end"): Json {
  const rules = itemsOf(config, path);
  if (rules.some((r) => same(r, rule))) return config;
  const i = at === "end" ? rules.length : at;
  return setIn(config, path, [...rules.slice(0, i), rule, ...rules.slice(i)]);
}

export interface Template {
  id: string;
  name: string;
  detail: string;
  apply: (config: Json) => Json;
}

/** Templates of routing rules. */
export const routeTemplates: Template[] = [
  {
    id: "hijack-dns",
    name: "DNS 劫持",
    detail: "先探测协议，再把 DNS 查询交给内置 DNS 处理（用 TUN 时需要）",
    apply: (c) => {
      let next = insertRule(c, ["route", "rules"], { action: "sniff" }, 0);
      const rules = itemsOf(next, ["route", "rules"]);
      next = insertRule(next, ["route", "rules"], { protocol: "dns", action: "hijack-dns" }, rules.findIndex((r) => isObject(r) && r.action === "sniff") + 1);
      return next;
    },
  },
  {
    id: "lan-direct",
    name: "局域网直连",
    detail: "访问局域网和私有地址时不走代理",
    apply: (c) => {
      const [next, direct] = ensureDirect(c);
      return insertRule(next, ["route", "rules"], { ip_is_private: true, action: "route", outbound: direct }, afterPrelude(itemsOf(next, ["route", "rules"])));
    },
  },
  {
    id: "ads",
    name: "广告拦截",
    detail: "拒绝连接广告域名（远程规则集 geosite-category-ads-all）",
    apply: (c) => {
      const next = ensureRuleSet(c, "geosite-category-ads-all");
      return insertRule(next, ["route", "rules"], { rule_set: "geosite-category-ads-all", action: "reject" }, afterPrelude(itemsOf(next, ["route", "rules"])));
    },
  },
  {
    id: "cn-direct",
    name: "国内直连",
    detail: "中国大陆的域名和 IP 直连，其余走默认出站（规则集 geosite-cn、geoip-cn）",
    apply: (c) => {
      let [next, direct] = ensureDirect(c);
      next = ensureRuleSet(ensureRuleSet(next, "geosite-cn"), "geoip-cn");
      return insertRule(next, ["route", "rules"], { rule_set: ["geosite-cn", "geoip-cn"], action: "route", outbound: direct }, "end");
    },
  },
];

/** Templates of DNS. */
export const dnsTemplates: Template[] = [
  {
    id: "split",
    name: "国内外分流 DNS",
    detail: "国内域名用国内 DNS（223.5.5.5）直连查询，其余用 1.1.1.1 经默认出站查询",
    apply: (c) => {
      let next = ensureRuleSet(c, "geosite-cn");
      const final = getIn(next, ["route", "final"]);
      // A server for each, reused when the configuration has one alike.
      const serverFor = (address: string, base: string, extra: Json): string => {
        const found = itemsOf(next, ["dns", "servers"]).find((s) => isObject(s) && s.type === "https" && s.server === address);
        if (found?.tag) return found.tag;
        const tag = uniqueTag(next, "dns_server", base);
        next = addItem(next, ["dns", "servers"], { type: "https", tag, server: address, ...extra });
        return tag;
      };
      const cn = serverFor("223.5.5.5", "dns-cn", {});
      const remote = serverFor("1.1.1.1", "dns-remote", typeof final === "string" && final ? { detour: final } : {});
      next = insertRule(next, ["dns", "rules"], { rule_set: "geosite-cn", action: "route", server: cn }, "end");
      next = setIn(next, ["dns", "final"], remote);
      // The servers of the outbounds, when domains, are resolved at home.
      if (!getIn(next, ["route", "default_domain_resolver"])) next = setIn(next, ["route", "default_domain_resolver"], cn);
      return next;
    },
  },
  {
    id: "ads",
    name: "拒绝解析广告域名",
    detail: "广告域名直接返回空结果（远程规则集 geosite-category-ads-all）",
    apply: (c) => {
      const next = ensureRuleSet(c, "geosite-category-ads-all");
      return insertRule(next, ["dns", "rules"], { rule_set: "geosite-category-ads-all", action: "reject" }, 0);
    },
  },
];

export const fakeipDefaults = { inet4_range: "198.18.0.0/15", inet6_range: "fc00::/18" };

/** The FakeIP server of the DNS, if any, and its index. */
export function fakeipServer(config: Json): [number, Json] {
  const servers = itemsOf(config, ["dns", "servers"]);
  const i = servers.findIndex((s) => isObject(s) && s.type === "fakeip");
  return [i, servers[i]];
}

/**
 * Turns FakeIP on: a fakeip server, and a rule that answers A and AAAA
 * queries from it. The core refuses fakeip as the default server: without
 * another, the system's DNS is added first and made the default.
 */
export function enableFakeIP(config: Json): Json {
  if (fakeipServer(config)[0] >= 0) return config;
  let next = config;
  if (itemsOf(next, ["dns", "servers"]).length === 0) {
    const local = uniqueTag(next, "dns_server", "dns-local");
    next = addItem(next, ["dns", "servers"], { type: "local", tag: local });
    if (!getIn(next, ["dns", "final"])) next = setIn(next, ["dns", "final"], local);
    // With DNS servers, the core wants to be told how to resolve the servers of outbounds.
    if (!getIn(next, ["route", "default_domain_resolver"])) next = setIn(next, ["route", "default_domain_resolver"], local);
  }
  const tag = uniqueTag(next, "dns_server", "fakeip");
  next = addItem(next, ["dns", "servers"], { type: "fakeip", tag, ...fakeipDefaults });
  return insertRule(next, ["dns", "rules"], { query_type: ["A", "AAAA"], action: "route", server: tag }, "end");
}

/** Turns FakeIP off: the server goes, with the rules that use it. */
export function disableFakeIP(config: Json): Json {
  const [i, server] = fakeipServer(config);
  if (i < 0) return config;
  const tag = tagsOfItem(server, i)[0];
  let next = removeItem(config, ["dns", "servers"], i);
  const rules = itemsOf(next, ["dns", "rules"]).filter((r) => !(isObject(r) && r.server === tag));
  next = setIn(next, ["dns", "rules"], rules.length ? rules : undefined);
  if (getIn(next, ["dns", "final"]) === tag) next = setIn(next, ["dns", "final"], undefined);
  return pruneEmpty(next, ["dns"]);
}

/** The configuration without an object left empty at a path, as dns once its servers go. */
export function pruneEmpty(config: Json, path: Path): Json {
  // The whole configuration stays, even empty.
  if (path.length === 0) return config;
  const v = getIn(config, path);
  return isObject(v) && Object.keys(v).length === 0 ? setIn(config, path, undefined) : config;
}
