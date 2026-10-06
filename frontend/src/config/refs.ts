// The parts of a configuration that name others by tag: a rule's outbound,
// a group's members, a rule's rule sets, a DNS server's detour. The schema
// marks them with "x-tag-reference"; this follows refs.go, which the check
// runs, so that the editor offers the tags there are, renames a tag
// everywhere, and says what still refers to one before it goes.
import { choose, resolve, schema, type Node } from "./schema";
import { getIn, isObject, pathText, setIn, type Json, type Path } from "./path";

export type TagKind = "outbound" | "inbound" | "rule_set" | "dns_server" | "certificate_provider" | "http_client" | "network_namespace";

export const tagKindNames: Record<TagKind, string> = {
  outbound: "出站",
  inbound: "入站",
  rule_set: "规则集",
  dns_server: "DNS 服务器",
  certificate_provider: "证书提供者",
  http_client: "HTTP 客户端",
  network_namespace: "网络命名空间",
};

/** Where the tags of each kind are defined. Endpoints are outbounds and inbounds both. */
export const tagSections: { path: Path; kinds: TagKind[] }[] = [
  { path: ["inbounds"], kinds: ["inbound"] },
  { path: ["outbounds"], kinds: ["outbound"] },
  { path: ["endpoints"], kinds: ["outbound", "inbound"] },
  { path: ["dns", "servers"], kinds: ["dns_server"] },
  { path: ["route", "rule_set"], kinds: ["rule_set"] },
  { path: ["certificate_providers"], kinds: ["certificate_provider"] },
  { path: ["http_clients"], kinds: ["http_client"] },
  { path: ["network_namespaces"], kinds: ["network_namespace"] },
];

/** The tags of an item; without one, the core names it by its index. */
export function tagsOfItem(item: Json, index: number): string[] {
  const t = item?.tag;
  const tags = typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x: Json) => typeof x === "string") : [];
  return tags.length === 0 || (tags.length === 1 && tags[0] === "") ? [String(index)] : tags;
}

/** The tags of a kind the configuration defines, in order. */
export function tagsOf(config: Json, kind: TagKind): string[] {
  const out: string[] = [];
  for (const s of tagSections) {
    if (!s.kinds.includes(kind)) continue;
    const items = getIn(config, s.path);
    if (Array.isArray(items)) items.forEach((it, i) => out.push(...tagsOfItem(it, i)));
  }
  // Without outbounds the core adds direct, unless the final outbound is
  // an endpoint; without DNS servers, local.
  if (kind === "outbound" && implicitDirect(config)) out.push("direct");
  if (kind === "dns_server" && out.length === 0) out.push("local");
  return [...new Set(out)];
}

/** Whether the core adds a direct outbound: no outbounds, and route.final names no endpoint instead. */
function implicitDirect(config: Json): boolean {
  const outbounds = getIn(config, ["outbounds"]);
  if (Array.isArray(outbounds) && outbounds.length > 0) return false;
  const final = getIn(config, ["route", "final"]);
  const endpoints = getIn(config, ["endpoints"]);
  return !final || !Array.isArray(endpoints) || !endpoints.some((e) => isObject(e) && e.tag === final);
}

export interface Ref {
  path: Path;
  kind: TagKind;
  tag: string;
}

/** Every reference of a configuration, in the order of its keys. */
export function findRefs(config: Json): Ref[] {
  const refs: Ref[] = [];
  const walk = (v: Json, raw: Node | undefined, path: Path) => {
    const s = resolve(raw);
    if (!s) return;
    const kind = s["x-tag-reference"] as TagKind | undefined;
    if (kind && typeof v === "string" && v !== "") refs.push({ path, kind, tag: v });
    for (const sub of (s.allOf ?? []) as Node[]) walk(v, sub, path);
    for (const key of ["oneOf", "anyOf"] as const) {
      const list = (s[key] ?? []) as Node[];
      const branch = list.length ? choose(v, list) : undefined;
      if (branch) walk(v, branch, path);
    }
    if (isObject(v)) {
      const props = (s.properties ?? {}) as Record<string, Node>;
      for (const k of Object.keys(v).sort()) if (props[k]) walk(v[k], props[k], [...path, k]);
    } else if (Array.isArray(v) && s.items) {
      v.forEach((x, i) => walk(x, s.items as Node, [...path, i]));
    }
  };
  walk(config, schema, []);
  const client = getIn(config, ["route", "default_http_client"]);
  if (typeof client === "string" && client) refs.push({ path: ["route", "default_http_client"], kind: "http_client", tag: client });
  return refs;
}

export interface Problem {
  path: string;
  message: string;
  /** Whether the core would refuse to start; a missing inbound only makes a rule match nothing. */
  fatal: boolean;
}

/** References to tags nothing defines, and tags defined twice. */
export function checkRefs(config: Json): Problem[] {
  const problems: Problem[] = [];
  const seen = new Map<string, string>();
  for (const s of tagSections) {
    const items = getIn(config, s.path);
    if (!Array.isArray(items)) continue;
    items.forEach((it, i) => {
      for (const tag of tagsOfItem(it, i)) {
        const key = `${s.kinds[0]}\0${tag}`;
        const path = `${pathText(s.path)}[${i}].tag`;
        const first = seen.get(key);
        if (first) problems.push({ path, message: `${tagKindNames[s.kinds[0]]}标签“${tag}”重复，${first} 已经用过`, fatal: true });
        else seen.set(key, path);
      }
    });
  }
  const known = new Map<TagKind, Set<string>>();
  const has = (kind: TagKind, tag: string) => {
    if (!known.has(kind)) known.set(kind, new Set(tagsOf(config, kind)));
    return known.get(kind)!.has(tag);
  };
  for (const r of findRefs(config)) {
    if (has(r.kind, r.tag)) continue;
    if (r.kind === "inbound") problems.push({ path: pathText(r.path), message: `引用的入站“${r.tag}”不存在，不影响启动，但它不会匹配任何连接`, fatal: false });
    else problems.push({ path: pathText(r.path), message: `引用的${tagKindNames[r.kind]}“${r.tag}”不存在`, fatal: true });
  }
  return problems;
}

/** The references to a tag. */
export function refsTo(config: Json, kind: TagKind, tag: string): Ref[] {
  return findRefs(config).filter((r) => r.kind === kind && r.tag === tag);
}

/** The configuration with every reference to a tag renamed. */
export function renameRefs(config: Json, kind: TagKind, from: string, to: string): Json {
  let next = config;
  for (const r of findRefs(config)) if (r.kind === kind && r.tag === from) next = setIn(next, r.path, to);
  return next;
}

/**
 * Whether a reference can go with its tag: it is an item of a list that
 * keeps other items. A list left empty would change what it means (a
 * rule's rule_set: [] matches everything), so such a reference stays, for
 * the check to show and the user to change.
 */
export function removable(config: Json, r: Ref): boolean {
  if (typeof r.path[r.path.length - 1] !== "number") return false;
  const list = getIn(config, r.path.slice(0, -1));
  return Array.isArray(list) && list.some((x) => x !== r.tag);
}

/** The configuration without the references to a tag that can go with it (see removable). */
export function removeListRefs(config: Json, kind: TagKind, tag: string): Json {
  let next = config;
  // From the last, so that the indexes of the others hold.
  const refs = findRefs(config)
    .filter((r) => r.kind === kind && r.tag === tag && removable(config, r))
    .reverse();
  for (const r of refs) next = setIn(next, r.path, undefined);
  return next;
}

/** Where a reference is, in the app's words: 策略组「proxy」、分流规则第 3 条. */
export function placeOf(config: Json, path: Path): string {
  const [a, b, c] = path;
  const tagAt = (p: Path) => {
    const item = getIn(config, p);
    return typeof item?.tag === "string" && item.tag ? item.tag : String(p[p.length - 1]);
  };
  if (a === "outbounds" && typeof b === "number") {
    const type = getIn(config, [a, b, "type"]);
    return type === "selector" || type === "urltest" ? `策略组「${tagAt([a, b])}」` : `出站「${tagAt([a, b])}」`;
  }
  if (a === "endpoints" && typeof b === "number") return `端点「${tagAt([a, b])}」`;
  if (a === "inbounds" && typeof b === "number") return `入站「${tagAt([a, b])}」`;
  if (a === "services" && typeof b === "number") return `服务「${tagAt([a, b])}」`;
  if (a === "http_clients" && typeof b === "number") return `HTTP 客户端「${tagAt([a, b])}」`;
  if (a === "route") {
    if (b === "final") return "默认出站";
    if (b === "rules" && typeof c === "number") return `分流规则第 ${c + 1} 条`;
    if (b === "rule_set" && typeof c === "number") return `规则集「${tagAt([a, b, c])}」`;
    if (b === "default_domain_resolver") return "默认域名解析";
    if (b === "default_http_client") return "默认 HTTP 客户端";
  }
  if (a === "dns") {
    if (b === "final") return "默认 DNS 服务器";
    if (b === "rules" && typeof c === "number") return `DNS 规则第 ${c + 1} 条`;
    if (b === "servers" && typeof c === "number") return `DNS 服务器「${tagAt([a, b, c])}」`;
  }
  return pathText(path);
}
