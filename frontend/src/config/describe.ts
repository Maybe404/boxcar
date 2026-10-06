// A rule in one sentence, as it matches. The core matches a default rule
// as (destination: domain || domain_suffix || … || ip_cidr || rule_set) &&
// (port || port_range) && (source address) && (source port) && every other
// field; the values of one field are alternatives. A rule set of a single
// default rule joins the destination group, as the common remote ones are.
import { isObject, type Json } from "./path";
import { def, resolve, type Node } from "./schema";

/** The conditions of rules, in the app's words. */
export const conditionNames: Record<string, string> = {
  domain: "域名是",
  domain_suffix: "域名后缀是",
  domain_keyword: "域名包含",
  domain_regex: "域名匹配正则",
  geosite: "geosite",
  geoip: "geoip",
  ip_cidr: "目标 IP 在",
  ip_is_private: "目标是局域网 IP",
  ip_accept_any: "解析出任意 IP",
  rule_set: "属于规则集",
  rule_set_ip_cidr_match_source: "规则集的 IP 段匹配来源地址",
  rule_set_ip_cidr_accept_empty: "规则集 IP 段接受空结果",
  port: "目标端口是",
  port_range: "目标端口范围",
  source_geoip: "来源 geoip",
  source_ip_cidr: "来源 IP 在",
  source_ip_is_private: "来源是局域网 IP",
  source_port: "来源端口是",
  source_port_range: "来源端口范围",
  inbound: "来自入站",
  ip_version: "IP 版本是",
  auth_user: "认证用户是",
  protocol: "协议是",
  client: "客户端是",
  network: "网络是",
  query_type: "查询类型是",
  process_name: "进程名是",
  process_path: "进程路径是",
  process_path_regex: "进程路径匹配正则",
  package_name: "安卓应用是",
  user: "系统用户是",
  user_id: "系统用户 ID 是",
  clash_mode: "当前模式是",
  network_type: "网络类型是",
  network_is_expensive: "网络按流量计费",
  network_is_constrained: "网络处于低数据模式",
  wifi_ssid: "Wi-Fi 名称是",
  wifi_bssid: "Wi-Fi BSSID 是",
  interface_address: "网卡地址在",
  network_interface_address: "网络接口地址在",
  default_interface_address: "默认网卡地址在",
  source_mac_address: "来源 MAC 是",
  source_hostname: "来源主机名是",
  preferred_by: "被出站优先使用",
  outbound: "出站是",
};

/** The groups of conditions whose fields are alternatives. */
const groups = [
  ["domain", "domain_suffix", "domain_keyword", "domain_regex", "geosite", "geoip", "ip_cidr", "ip_is_private", "ip_accept_any", "rule_set"],
  ["port", "port_range"],
  ["source_geoip", "source_ip_cidr", "source_ip_is_private"],
  ["source_port", "source_port_range"],
];

export type RuleKind = "route" | "dns";

/** The node of the conditions of a default rule. */
export function conditionsNode(kind: RuleKind): Node {
  return resolve(def(kind === "dns" ? "DNSRule" : "Rule").oneOf[0].allOf[0])!;
}

/** The node of the actions of a rule. */
export function actionNode(kind: RuleKind): Node {
  return def(kind === "dns" ? "DNSRuleAction" : "RuleAction");
}

const conditionKeys = {
  route: new Set(Object.keys(conditionsNode("route").properties).filter((k) => k !== "type" && k !== "invert")),
  dns: new Set(Object.keys(conditionsNode("dns").properties).filter((k) => k !== "type" && k !== "invert")),
};

/** Whether a key of a rule is a condition, not part of its action. */
export function isConditionKey(key: string, kind: RuleKind): boolean {
  return conditionKeys[kind].has(key);
}

function values(v: Json): Json[] {
  return Array.isArray(v) ? v : [v];
}

function list(vs: Json[]): string {
  const s = vs.map(String);
  if (s.length === 1) return s[0];
  if (s.length <= 3) return `${s.slice(0, -1).join("、")} 或 ${s[s.length - 1]}`;
  return `${s.slice(0, 2).join("、")} 等 ${s.length} 个之一`;
}

/** One condition: 域名后缀是 github.com 或 gitlab.com. */
export function describeCondition(key: string, value: Json): string {
  const name = conditionNames[key] ?? key;
  if (typeof value === "boolean") return value ? name : `不是“${name}”`;
  if (key === "ip_version") return `${name} IPv${value}`;
  return `${name} ${list(values(value))}`;
}

/** The conditions of a default rule, grouped as the core matches them. */
export function describeConditions(rule: Json, kind: RuleKind): string {
  if (!isObject(rule)) return "";
  const keys = Object.keys(rule).filter((k) => isConditionKey(k, kind) && rule[k] !== undefined && !(Array.isArray(rule[k]) && rule[k].length === 0));
  const parts: string[] = [];
  const used = new Set<string>();
  for (const g of groups) {
    const inGroup = keys.filter((k) => g.includes(k));
    inGroup.forEach((k) => used.add(k));
    if (inGroup.length === 0) continue;
    const text = inGroup.map((k) => describeCondition(k, rule[k])).join(" 或 ");
    parts.push(inGroup.length > 1 ? `（${text}）` : text);
  }
  for (const k of keys) if (!used.has(k)) parts.push(describeCondition(k, rule[k]));
  return parts.join("，且");
}

/** The whole match of a rule, logical ones included. */
export function describeMatch(rule: Json, kind: RuleKind = "route"): string {
  if (!isObject(rule)) return "";
  let text: string;
  if (rule.type === "logical") {
    const subs = (Array.isArray(rule.rules) ? rule.rules : []).map((r: Json) => {
      const t = describeMatch(r, kind);
      // Brackets only around a sub-rule of several conditions.
      return t.includes("，且") || t.includes("：") ? `［${t}］` : t;
    });
    text = subs.length === 0 ? "（没有子规则）" : rule.mode === "or" ? `满足任一：${subs.join("；")}` : `同时满足：${subs.join("；")}`;
  } else {
    text = describeConditions(rule, kind) || (kind === "dns" ? "所有查询" : "所有流量");
  }
  return rule.invert ? `不满足［${text}］时` : text;
}

/** What a routing rule does. */
export function describeAction(rule: Json): string {
  if (!isObject(rule)) return "";
  const action = rule.action ?? "route";
  switch (action) {
    case "route":
      return rule.outbound ? `走 ${rule.outbound}` : "走（未选择出站）";
    case "reject":
      return rule.method === "drop" ? "丢弃" : "拒绝";
    case "hijack-dns":
      return "交给内置 DNS";
    case "sniff":
      return rule.sniffer ? `探测协议（${list(values(rule.sniffer))}）` : "探测协议";
    case "resolve":
      return rule.server ? `用 ${rule.server} 解析域名` : "解析域名";
    case "direct":
      return "直连";
    case "bypass":
      return "绕过";
    case "route-options":
      return "设置路由选项";
  }
  return String(action);
}

/** What a DNS rule does. */
export function describeDNSAction(rule: Json): string {
  if (!isObject(rule)) return "";
  const action = rule.action ?? "route";
  switch (action) {
    case "route":
      return rule.server ? `用 ${rule.server} 查询` : "查询（未选择服务器）";
    case "evaluate":
      return rule.server ? `先用 ${rule.server} 查询再判断` : "先查询再判断";
    case "respond":
      return "返回已查到的结果";
    case "reject":
      return rule.method === "drop" ? "丢弃查询" : "拒绝查询";
    case "predefined":
      return "返回预设应答";
    case "route-options":
      return "设置查询选项";
  }
  return String(action);
}

/** A rule in one sentence: 域名后缀是 github.com → 走 proxy. */
export function describeRule(rule: Json, kind: RuleKind = "route"): { match: string; action: string } {
  return { match: describeMatch(rule, kind), action: kind === "dns" ? describeDNSAction(rule) : describeAction(rule) };
}
