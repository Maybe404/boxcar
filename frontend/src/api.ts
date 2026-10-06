// The page talks to Go through the client `mygo generate` writes. Opened in
// a plain browser (the Vite dev server), there is no Go side: a preview
// stands in for it with synthetic data, and the window says so.
import { isMyGo } from "mygo-runtime";
import { Box, events as goEvents } from "./mygo";
import { parseConfig, stringifyConfig } from "./config/jsonc";
import type {
  About,
  Activity,
  ActivityKind,
  CheckResult,
  Connection,
  DNSResult,
  ImportResult,
  LegacyData,
  LogLine,
  OutboundGroup,
  Profiles,
  Remote,
  RuleInfo,
  Snapshot,
  Theme,
} from "./mygo";

export type * from "./mygo";

export const preview = !isMyGo();

type Listener<T> = (payload: T) => void;

function emitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    on(fn: Listener<T>) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit(payload: T) {
      listeners.forEach((fn) => fn(payload));
    },
  };
}

// ---- The preview ----

const sampleConfig = `{
  "log": { "level": "info", "timestamp": true },
  "inbounds": [
    { "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2080 }
  ],
  "outbounds": [
    { "type": "selector", "tag": "proxy", "outbounds": ["auto", "香港 01", "日本 01", "direct"] },
    { "type": "urltest", "tag": "auto", "outbounds": ["香港 01", "日本 01", "新加坡 01"] },
    {
      "type": "vless", "tag": "香港 01", "server": "hk1.example.com", "server_port": 443,
      "uuid": "00000000-0000-4000-8000-000000000001", "flow": "xtls-rprx-vision",
      "tls": { "enabled": true, "server_name": "hk1.example.com" }
    },
    { "type": "hysteria2", "tag": "日本 01", "server": "jp1.example.com", "server_port": 443, "password": "example", "tls": { "enabled": true } },
    { "type": "trojan", "tag": "新加坡 01", "server": "sg1.example.com", "server_port": 443, "password": "example", "tls": { "enabled": true } },
    { "type": "direct", "tag": "direct" }
  ],
  "route": { "final": "proxy" }
}
`;

// A fuller configuration, as subscriptions often are: rules, rule sets, DNS.
const subscriptionConfig = `{
  // Synthetic: the servers are example.com.
  "log": { "level": "warn" },
  "dns": {
    "servers": [
      { "type": "https", "tag": "dns-cn", "server": "223.5.5.5" },
      { "type": "https", "tag": "dns-remote", "server": "1.1.1.1", "detour": "proxy" }
    ],
    "rules": [{ "rule_set": "geosite-cn", "action": "route", "server": "dns-cn" }],
    "final": "dns-remote"
  },
  "inbounds": [
    { "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 7890 }
  ],
  "outbounds": [
    { "type": "selector", "tag": "proxy", "outbounds": ["香港 01", "日本 01"] },
    { "type": "vless", "tag": "香港 01", "server": "hk1.example.com", "server_port": 443, "uuid": "00000000-0000-4000-8000-000000000001" },
    { "type": "shadowsocks", "tag": "日本 01", "server": "jp1.example.com", "server_port": 8388, "method": "2022-blake3-aes-128-gcm", "password": "example" },
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "rules": [
      { "action": "sniff" },
      { "protocol": "dns", "action": "hijack-dns" },
      { "ip_is_private": true, "outbound": "direct" },
      { "domain_suffix": ["github.com", "githubusercontent.com"], "outbound": "proxy" },
      { "rule_set": ["geosite-cn", "geoip-cn"], "action": "route", "outbound": "direct" }
    ],
    "rule_set": [
      { "type": "remote", "tag": "geosite-cn", "format": "binary", "url": "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs" },
      { "type": "remote", "tag": "geoip-cn", "format": "binary", "url": "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs" }
    ],
    "final": "proxy",
    "default_domain_resolver": "dns-cn"
  }
}
`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

function makePreview() {
  const state = emitter<Snapshot>();
  const logs = emitter<number>();
  const navigate = emitter<string>();
  const profilesEvent = emitter<number>();
  let status: Snapshot["status"] = "stopped";
  let startedAt = 0;
  let up = 0;
  let down = 0;
  let upHist: number[] = [];
  let downHist: number[] = [];
  let version = 0;
  let mode = "Rule";
  let systemProxy = false;
  let loginItem = false;
  let legacyOffer = new URLSearchParams(location.search).has("legacy");
  const logLines: LogLine[] = [];
  const activity: Activity[] = [];
  let theme: Theme = "system";
  const groups: OutboundGroup[] = [
    {
      tag: "proxy",
      type: "selector",
      selected: "香港 01",
      selectable: true,
      items: [
        { tag: "auto", type: "urltest", delay: 0 },
        { tag: "香港 01", type: "vless", delay: 46 },
        { tag: "香港 02", type: "vless", delay: 58 },
        { tag: "日本 01", type: "hysteria2", delay: 91 },
        { tag: "新加坡 01", type: "trojan", delay: 133 },
        { tag: "美国 01", type: "shadowsocks", delay: 412 },
        { tag: "direct", type: "direct", delay: 0 },
      ],
    },
    {
      tag: "auto",
      type: "urltest",
      selected: "香港 01",
      selectable: false,
      items: [
        { tag: "香港 01", type: "vless", delay: 46 },
        { tag: "日本 01", type: "hysteria2", delay: 91 },
        { tag: "新加坡 01", type: "trojan", delay: 1290 },
      ],
    },
  ];
  const profiles: Profiles = {
    active: "本地代理示例",
    items: [
      { name: "本地代理示例", path: "~/Library/Application Support/Boxcar/profiles/本地代理示例.json", size: 512, modified: iso(Date.now() - 36e5), remote: null },
      {
        name: "机场订阅",
        path: "~/Library/Application Support/Boxcar/profiles/机场订阅.json",
        size: 18342,
        modified: iso(Date.now() - 864e5),
        remote: { url: "https://example.com/sub/sing-box.json", autoUpdate: true, interval: 60, updatedAt: iso(Date.now() - 864e5) },
      },
    ],
  };
  const files: Record<string, string> = { 本地代理示例: sampleConfig, 机场订阅: subscriptionConfig };
  const closed: Connection[] = [];

  const bump = () => logs.emit(++version);
  const addLog = (level: string, message: string, source: "core" | "app" = "core") => {
    logLines.push({ time: iso(Date.now()), level, source, message });
    if (logLines.length > 2000) logLines.splice(0, 200);
    bump();
  };
  const addActivity = (kind: ActivityKind, tag: string, message: string, level = "info") => {
    activity.push({ time: iso(Date.now()), kind, level, tag, message });
    if (activity.length > 2000) activity.splice(0, 200);
    bump();
  };

  const snapshot = (): Snapshot => {
    const proxy = groups[0];
    const running = status === "running";
    const chain = ["proxy", proxy.selected];
    if (proxy.selected === "auto") chain.push(groups[1].selected);
    return {
      status,
      profile: profiles.active,
      startedAt: running ? startedAt : 0,
      stats: running
        ? {
            upload: up,
            download: down,
            uploadRate: upHist.at(-1) ?? 0,
            downloadRate: downHist.at(-1) ?? 0,
            connections: 7,
            outboundConnections: 5,
            memory: 46_137_344,
            goroutines: 112,
            uploadHistory: upHist,
            downHistory: downHist,
          }
        : { upload: 0, download: 0, uploadRate: 0, downloadRate: 0, connections: 0, outboundConnections: 0, memory: 0, goroutines: 0, uploadHistory: [], downHistory: [] },
      line: [
        { kind: "device", title: "本机" },
        { kind: "inbound", title: "mixed-in", detail: "mixed · 127.0.0.1:2080" },
        ...chain.map((tag, i) => ({
          kind: (i === chain.length - 1 ? "node" : "group") as "node" | "group",
          title: tag,
          detail: i === 0 ? "selector" : tag === "auto" ? "urltest" : "vless",
        })),
        { kind: "internet", title: "互联网" },
      ],
      mode: running ? { current: mode, list: ["Rule", "Global", "Direct"] } : { current: "", list: [] },
      warnings: running ? [{ message: "legacy DNS server format is deprecated in sing-box 1.12.0 and will be removed in sing-box 1.14.0", link: "https://sing-box.sagernet.org/migration/", impending: true }] : [],
      logLevel: running ? "info" : undefined,
      systemProxy: { enabled: systemProxy, active: running && systemProxy, address: running && systemProxy ? "127.0.0.1:2080" : undefined },
    };
  };

  const hosts = ["www.google.com", "github.com", "api.openai.com", "i.ytimg.com", "1.1.1.1", "registry.npmjs.org", "fonts.gstatic.com"];
  const connection = (i: number, now: number, closedAt?: number): Connection => ({
    id: String(i),
    seq: i + 1,
    logId: 1_000_000 + i * 7919,
    client: i % 2 ? "safari" : undefined,
    addresses: i % 5 === 4 ? [] : [`142.250.${i}.${100 + i}`],
    inbound: "mixed-in",
    inboundType: "mixed",
    network: i % 5 === 4 ? "udp" : "tcp",
    ipVersion: 4,
    source: `127.0.0.1:${50000 + i}`,
    destination: i % 5 === 4 ? "1.1.1.1:53" : `${hosts[i % hosts.length]}:443`,
    domain: i % 5 === 4 ? "" : hosts[i % hosts.length],
    protocol: i % 5 === 4 ? "dns" : "tls",
    process: i % 2 ? "Safari" : "curl",
    processPath: i % 2 ? "/Applications/Safari.app/Contents/MacOS/Safari" : "/usr/bin/curl",
    rule: i === 1 ? "domain_suffix=github.com => route(proxy)" : "final",
    outbound: i % 5 === 4 ? "direct" : groups[0].selected,
    outboundType: i % 5 === 4 ? "direct" : "vless",
    chain: i % 5 === 4 ? ["direct"] : ["proxy", groups[0].selected],
    upload: 2_000 * (i + 3) * (1 + Math.sin(now / 9e3)),
    download: 90_000 * (i + 1) * (2 + Math.sin(now / 7e3)),
    uploadRate: closedAt ? 0 : Math.round(300 * (i + 1) * (1 + Math.sin(now / 3e3 + i))),
    downloadRate: closedAt ? 0 : Math.round(12_000 * (i + 1) * (1 + Math.sin(now / 2e3 + i))),
    createdAt: iso(now - (i * 47 + 5) * 1000),
    closedAt: closedAt ? iso(closedAt) : undefined,
  });

  setInterval(() => {
    if (status !== "running") return;
    const t = Date.now() / 1000;
    const d = Math.max(0, 1_400_000 + 900_000 * Math.sin(t / 6) + Math.random() * 300_000);
    const u = Math.max(0, 60_000 + 40_000 * Math.sin(t / 4) + Math.random() * 20_000);
    down += d;
    up += u;
    downHist = [...downHist, d].slice(-60);
    upHist = [...upHist, u].slice(-60);
    if (Math.random() < 0.5) addActivity("dns", "dns", `exchanged ${hosts[Math.floor(Math.random() * hosts.length)]}. IN A 300s`);
    if (Math.random() < 0.4) {
      const i = Math.floor(Math.random() * hosts.length);
      const id = 1_000_000 + i * 7919;
      addLog("info", `[${id} 0ms] inbound/mixed[mixed-in]: inbound connection to ${hosts[i]}:443`);
      addLog("info", `[${id} 2ms] outbound/vless[${groups[0].selected}]: outbound connection to ${hosts[i]}:443`);
    }
    if (Math.random() < 0.15) closed.unshift(connection(closed.length + 20, Date.now(), Date.now()));
    state.emit(snapshot());
  }, 1000);

  const box = {
    async state() {
      return snapshot();
    },
    async takeover() {
      return [] as string[];
    },
    async start() {
      status = "starting";
      state.emit(snapshot());
      await wait(900);
      status = "running";
      startedAt = Date.now();
      addLog("info", "inbound/mixed[mixed-in]: tcp server started at 127.0.0.1:2080");
      addLog("info", "sing-box started (0.31s)");
      addLog("info", `已启动配置“${profiles.active}”`, "app");
      addLog("warn", "配置用了废弃的写法：legacy DNS server format is deprecated in sing-box 1.12.0", "app");
      if (systemProxy) addLog("info", "系统代理已指向 127.0.0.1:2080", "app");
      addActivity("urltest", "outbound/urltest[auto]", "outbound 香港 01 available: 46ms");
      addActivity("rule-set", "router", "updated rule-set geosite-cn");
      state.emit(snapshot());
    },
    async stop() {
      status = "stopping";
      state.emit(snapshot());
      await wait(400);
      status = "stopped";
      up = down = 0;
      upHist = [];
      downHist = [];
      if (systemProxy) addLog("info", "系统代理已恢复为原来的设置", "app");
      addLog("info", "内核已停止", "app");
      state.emit(snapshot());
    },
    async reload() {
      await box.stop();
      await box.start();
    },
    async groups() {
      return status === "running" ? structuredClone(groups) : [];
    },
    async select(group: string, tag: string) {
      const g = groups.find((g) => g.tag === group);
      if (g) g.selected = tag;
      state.emit(snapshot());
    },
    async urlTest(group: string) {
      await wait(1200);
      groups
        .find((g) => g.tag === group)
        ?.items.forEach((it) => {
          if (it.type !== "direct" && it.type !== "urltest") it.delay = Math.round(30 + Math.random() * 400);
        });
    },
    async testOutbound(tag: string) {
      await wait(600);
      const delay = Math.round(30 + Math.random() * 400);
      groups.forEach((g) => g.items.forEach((it) => it.tag === tag && (it.delay = delay)));
      return delay;
    },
    async setMode(m: string) {
      mode = m;
      state.emit(snapshot());
    },
    async connections(isClosed: boolean): Promise<Connection[]> {
      if (isClosed) return closed;
      if (status !== "running") return [];
      const now = Date.now();
      return hosts.map((_, i) => connection(i, now));
    },
    async closeConnection() {},
    async closeAllConnections() {},
    async clearClosedConnections() {
      closed.length = 0;
    },
    async activity(kind: ActivityKind, query: string) {
      return activity.filter((a) => (!kind || a.kind === kind) && a.message.toLowerCase().includes(query.toLowerCase()));
    },
    async clearActivity() {
      activity.length = 0;
      bump();
    },
    async rules(): Promise<RuleInfo[]> {
      return status === "running"
        ? [
            { index: 0, type: "default", rule: "protocol=dns", action: "hijack-dns" },
            { index: 1, type: "default", rule: "domain_suffix=github.com", action: "route(proxy)" },
            { index: 2, type: "default", rule: "rule_set=geosite-cn", action: "route(direct)" },
          ]
        : [];
    },
    async clearDNSCache() {},
    async resetFakeIP() {},
    async queryDNS(name: string, qtype: string): Promise<DNSResult> {
      if (status !== "running") throw new Error("内核没有运行");
      await wait(120);
      const n = name.trim().replace(/\.$/, "");
      if (!n) throw new Error("填写要查询的域名");
      const type = (qtype || "A").toUpperCase();
      const data = type === "AAAA" ? "2606:4700::6810:84e5" : type === "CNAME" ? `edge.${n}` : "104.16.132.229";
      return { rcode: "NOERROR", answers: [{ name: n, type, ttl: 300, data }], took: 23 };
    },
    async logs(level: string, source: string, query: string, limit: number) {
      const rank: Record<string, number> = { error: 2, warn: 3, info: 4, debug: 5, trace: 6 };
      const max = level === "all" ? 9 : (rank[level] ?? 4);
      return logLines
        .filter((l) => (rank[l.level] ?? 4) <= max && (!source || l.source === source) && l.message.toLowerCase().includes(query.toLowerCase()))
        .slice(-limit);
    },
    async clearLogs() {
      logLines.length = 0;
      bump();
    },
    async exportLogs() {
      return "";
    },
    async profiles() {
      return structuredClone(profiles);
    },
    async readProfile(name: string) {
      await wait(30);
      return files[name] ?? "";
    },
    async saveProfile(name: string, content: string) {
      files[name] = content;
    },
    async checkProfile(content: string): Promise<CheckResult> {
      await wait(200);
      const parsed = parseConfig(content);
      if (!parsed.ok) return { ok: false, error: parsed.error, warnings: [], problems: [] };
      // The same static check as the app's; the build of the core is not previewed.
      const { checkRefs } = await import("./config/refs");
      const problems = checkRefs(parsed.value);
      const fatal = problems.filter((p) => p.fatal).length;
      if (fatal) return { ok: false, error: `有 ${fatal} 处引用不存在或标签重复，启动时会失败`, warnings: [], problems };
      return { ok: true, warnings: [], problems };
    },
    async formatProfile(content: string) {
      const parsed = parseConfig(content);
      if (!parsed.ok) throw new Error(parsed.error);
      return stringifyConfig(parsed.value);
    },
    async newProfile() {
      let name = "新配置";
      for (let i = 2; files[name] !== undefined; i++) name = `新配置 ${i}`;
      files[name] = sampleConfig;
      profiles.items.push({ name, path: `~/…/profiles/${name}.json`, size: sampleConfig.length, modified: iso(Date.now()), remote: null });
      return name;
    },
    async importProfiles(): Promise<ImportResult> {
      return { names: [], failed: [] };
    },
    async importFiles(): Promise<ImportResult> {
      return { names: [], failed: [] };
    },
    async addRemoteProfile(name: string, link: string, autoUpdate: boolean, interval: number) {
      await wait(800);
      const n = name || "订阅";
      files[n] = sampleConfig;
      profiles.items.push({ name: n, path: `~/…/profiles/${n}.json`, size: sampleConfig.length, modified: iso(Date.now()), remote: { url: link, autoUpdate, interval, updatedAt: iso(Date.now()) } });
      return n;
    },
    async setRemote(name: string, r: Remote) {
      const p = profiles.items.find((p) => p.name === name);
      if (p) p.remote = { ...p.remote, ...r };
    },
    async updateProfile(name: string) {
      await wait(900);
      const p = profiles.items.find((p) => p.name === name);
      if (p?.remote) p.remote.updatedAt = iso(Date.now());
      profilesEvent.emit(Date.now());
    },
    async renameProfile(from: string, to: string) {
      const p = profiles.items.find((p) => p.name === from);
      if (!p) return;
      p.name = to;
      files[to] = files[from];
      delete files[from];
      if (profiles.active === from) profiles.active = to;
    },
    async deleteProfile(name: string) {
      profiles.items = profiles.items.filter((p) => p.name !== name);
      if (profiles.active === name) profiles.active = "";
    },
    async setActive(name: string) {
      profiles.active = name;
      state.emit(snapshot());
    },
    async legacyData(): Promise<LegacyData> {
      // Shown in the preview with ?legacy.
      return { available: legacyOffer, dir: "~/Library/Application Support/SingBox", profiles: ["家里", "机场订阅"] };
    },
    async importLegacy(): Promise<ImportResult> {
      legacyOffer = false;
      await wait(300);
      // As the app does: a name taken gets a number.
      const names = ["家里", "机场订阅"].map((base) => {
        let name = base;
        for (let i = 2; files[name] !== undefined; i++) name = `${base} ${i}`;
        files[name] = sampleConfig;
        profiles.items.push({ name, path: `~/…/profiles/${name}.json`, size: sampleConfig.length, modified: iso(Date.now()), remote: null });
        return name;
      });
      return { names, failed: [] };
    },
    async dismissLegacy() {
      legacyOffer = false;
    },
    async revealProfile() {},
    async openDataDir() {},
    async theme() {
      return theme;
    },
    async setTheme(t: Theme) {
      theme = t;
    },
    async setSystemProxy(on: boolean) {
      systemProxy = on;
      state.emit(snapshot());
    },
    async currentSystemProxy() {
      return "127.0.0.1:6152";
    },
    async loginItem() {
      return loginItem;
    },
    async setLoginItem(open: boolean) {
      loginItem = open;
    },
    async about(): Promise<About> {
      return {
        app: "0.2.0",
        version: "1.14.2（预览）",
        go: "go1.27.1",
        platform: "darwin/arm64",
        mygo: "0.2.12",
        tags: ["quic", "utls", "wireguard", "tailscale", "clash_api"],
        missing: ["outbounds/naive", "services/ccm", "services/usbip-client", "services/usbip-server"],
        dataDir: "~/Library/Application Support/Boxcar",
      };
    },
  } satisfies { [K in keyof typeof Box]: (...args: never[]) => Promise<unknown> };

  return {
    box: box as unknown as typeof Box,
    events: { state, logs, navigate, profiles: profilesEvent },
  };
}

const impl = preview
  ? makePreview()
  : {
      box: Box,
      events: {
        state: { on: (fn: Listener<Snapshot>) => goEvents.state.on(fn) },
        logs: { on: (fn: Listener<number>) => goEvents.logs.on(fn) },
        navigate: { on: (fn: Listener<string>) => goEvents.navigate.on(fn) },
        profiles: { on: (fn: Listener<number>) => goEvents.profiles.on(fn) },
      },
    };

export const box = impl.box;
export const events = impl.events;

/** The message of an error thrown by a call. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The built-in Clash modes, in the app's words. */
export function modeLabel(mode: string): string {
  return ({ rule: "规则", global: "全局", direct: "直连" } as Record<string, string>)[mode.toLowerCase()] ?? mode;
}
