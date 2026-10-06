// The app's words for the values a configuration chooses between.
import type { Json } from "./path";

/** The keys that choose a branch. */
export const discriminatorNames: Record<string, string> = {
  type: "类型",
  action: "动作",
  mode: "模式",
  version: "版本",
  provider: "提供者",
};

const ruleTypes: Record<string, string> = { default: "普通规则", logical: "逻辑组合（且 / 或）" };

export const routeActions: Record<string, string> = {
  route: "路由到出站",
  "route-options": "只设置路由选项",
  direct: "直连（不经出站）",
  bypass: "绕过（交给系统）",
  reject: "拒绝",
  "hijack-dns": "交给内置 DNS 处理",
  sniff: "探测协议",
  resolve: "解析域名为 IP",
};

export const dnsActions: Record<string, string> = {
  route: "使用 DNS 服务器",
  evaluate: "先查询再判断",
  respond: "返回已查到的结果",
  "route-options": "只设置查询选项",
  reject: "拒绝查询",
  predefined: "返回预设的应答",
};

/** The protocols and kinds of servers, as people call them. */
export const typeNames: Record<string, string> = {
  selector: "手动选择（selector）",
  urltest: "自动选最快（urltest）",
  direct: "直连（direct）",
  block: "拦截（block）",
  mixed: "HTTP + SOCKS（mixed）",
  tun: "虚拟网卡（tun）",
  local: "系统 DNS（local）",
  fakeip: "FakeIP",
  hosts: "hosts 文件",
  dhcp: "DHCP 下发",
  https: "DNS over HTTPS",
  h3: "DNS over HTTP/3",
  tls: "DNS over TLS",
  quic: "DNS over QUIC",
  udp: "普通 DNS（UDP）",
  tcp: "普通 DNS（TCP）",
  remote: "远程（下载）",
  inline: "内联",
};

/** A label for a value a discriminator takes. */
export function variantLabel(key: string, value: Json, context?: "route" | "dns"): string {
  if (value === "" || value === undefined) return "默认";
  const v = String(value);
  if (key === "action") return (context === "dns" ? dnsActions : routeActions)[v] ?? v;
  if (key === "type" && ruleTypes[v]) return ruleTypes[v];
  if (key === "mode") return v === "and" ? "全部满足（且）" : v === "or" ? "任一满足（或）" : v;
  if (key === "version") return `版本 ${v}`;
  return v;
}
