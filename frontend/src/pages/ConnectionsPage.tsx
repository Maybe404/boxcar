// Every connection sing-box routed, open and closed, recorded as the
// router hands it on so that none is missed; and the core's own network
// work that is not a routed connection: DNS, rule-sets, URL tests, NTP,
// rejected and hijacked connections.
import { useEffect, useMemo, useState } from "react";
import { Dialog, ToggleGroup } from "radix-ui";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { box, errorText, events, type Activity, type ActivityKind, type Connection, type DNSRecord, type LogLine, type Snapshot } from "../api";
import { DNSQuery } from "../components/DNSQuery";
import { ProcessIcon } from "../components/ProcessIcon";
import { bytes, clock, duration, rate } from "../format";
import { useNow, usePoll } from "../hooks";
import { Route } from "../components/Route";
import { Stopped } from "../components/Stopped";

type Tab = "open" | "closed" | "dns" | "activity";
type Sort = "time" | "traffic" | "host";
/** How the list is split: by the program that made the connection, or by where it went. */
type GroupBy = "" | "process" | "host";

const processOf = (c: Connection) => c.process || "未知进程";
const hostOf = (c: Connection) => c.domain || c.destination.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");

export function ConnectionsPage({ snap }: { snap: Snapshot }) {
  const running = snap.status === "running";
  const [tab, setTab] = useState<Tab>("open");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("time");
  const [groupBy, setGroupBy] = useState<GroupBy>("");
  const [chosen, setGroup] = useState<string | null>(null);
  const [detail, setDetail] = useState<Connection | null>(null);
  const listing = tab === "open" || tab === "closed";
  const now = useNow(listing);
  const [conns, refresh] = usePoll<Connection[]>(() => box.connections(tab === "closed"), 1000, listing, [], [tab]);

  if (!running && tab === "open") {
    return (
      <>
        <Toolbar tab={tab} setTab={setTab} query={query} setQuery={setQuery} />
        <Stopped title="内核未运行" detail="启动后，这里会实时列出经过内核的每一个连接；已结束的连接和内核自身的网络活动在另外两个标签里。" status={snap.status} profile={snap.profile} />
      </>
    );
  }

  const q = query.trim().toLowerCase();
  let list = q
    ? conns.filter((c) =>
        `${c.domain} ${c.destination} ${c.source} ${c.chain.join(" ")} ${c.rule} ${c.inbound} ${c.process ?? ""} ${c.protocol ?? ""} ${c.network}`.toLowerCase().includes(q),
      )
    : conns;
  // The groups, by count, before choosing one narrows the list.
  const keyOf = groupBy === "process" ? processOf : groupBy === "host" ? hostOf : null;
  const groups = keyOf ? countBy(list, keyOf) : [];
  // A group whose connections are all gone, or not in this tab, is let go.
  const group = chosen !== null && groups.some((g) => g.key === chosen) ? chosen : null;
  if (keyOf && group !== null) list = list.filter((c) => keyOf(c) === group);
  if (sort === "traffic") list = [...list].sort((a, b) => b.upload + b.download - (a.upload + a.download));
  if (sort === "host") list = [...list].sort((a, b) => (a.domain || a.destination).localeCompare(b.domain || b.destination));

  return (
    <>
      <Toolbar tab={tab} setTab={setTab} query={query} setQuery={setQuery}>
        {listing && (
          <ToggleGroup.Root
            className="segmented"
            type="single"
            value={groupBy || "none"}
            onValueChange={(v) => {
              if (!v) return;
              setGroupBy(v === "none" ? "" : (v as GroupBy));
              setGroup(null);
            }}
            aria-label="分组"
          >
            <ToggleGroup.Item value="none">不分组</ToggleGroup.Item>
            <ToggleGroup.Item value="process">按客户端</ToggleGroup.Item>
            <ToggleGroup.Item value="host">按主机</ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
        {listing && (
          <ToggleGroup.Root className="segmented" type="single" value={sort} onValueChange={(v) => v && setSort(v as Sort)} aria-label="排序">
            <ToggleGroup.Item value="time">时间</ToggleGroup.Item>
            <ToggleGroup.Item value="traffic">流量</ToggleGroup.Item>
            <ToggleGroup.Item value="host">目标</ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
        {tab === "open" && (
          <button
            className="btn ghost"
            disabled={list.length === 0}
            onClick={async () => {
              await box.closeAllConnections();
              refresh();
            }}
          >
            全部断开
          </button>
        )}
        {tab === "closed" && (
          <button
            className="btn ghost"
            disabled={list.length === 0}
            onClick={async () => {
              await box.clearClosedConnections();
              refresh();
            }}
          >
            清空
          </button>
        )}
      </Toolbar>

      {tab === "activity" ? (
        <ActivityList query={query} />
      ) : tab === "dns" ? (
        <DNSList query={query} running={running} />
      ) : (
        <div className="table">
          {keyOf && (
            <div className="conn-groups" role="group" aria-label={groupBy === "process" ? "客户端" : "主机"}>
              <button type="button" className="conn-group" aria-pressed={group === null} onClick={() => setGroup(null)}>
                全部 <span className="faint">{groups.reduce((n, g) => n + g.count, 0)}</span>
              </button>
              {groups.map((g) => (
                <button type="button" key={g.key} className="conn-group" aria-pressed={group === g.key} onClick={() => setGroup(group === g.key ? null : g.key)} title={g.key}>
                  {groupBy === "process" && <ProcessIcon path={g.path} />}
                  <span className="ellipsis">{g.key}</span> <span className="faint">{g.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="thead">
            <span>协议</span>
            <span>目标</span>
            <span>线路</span>
            <span className="r">上传</span>
            <span className="r">下载</span>
            <span className="r">{tab === "closed" ? "结束于" : "时长"}</span>
            <span />
          </div>
          {list.map((c) => (
            <div className={`trow${c.error ? " failed" : ""}`} key={c.id} onClick={() => setDetail(c)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setDetail(c)}>
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span className="net">{c.network.toUpperCase()}</span>
                <span className="faint" style={{ fontSize: 10.5 }} title="序号">
                  #{c.seq}
                </span>
              </span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span className="host" title={c.destination}>
                  {c.domain || c.destination}
                </span>
                {(c.process || c.protocol || c.error) && (
                  <span className="faint ellipsis proc" style={{ fontSize: 11 }}>
                    <ProcessIcon path={c.processPath} size={12} />
                    {c.error && <span className="danger-text" style={{ marginRight: 4 }}>失败 ·</span>}
                    {[c.process, c.protocol?.toUpperCase(), c.flow ? "TUN 预匹配" : ""].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <Route chain={c.chain} inbound={c.inbound} outbound={c.outbound} />
                <span className="faint ellipsis" style={{ fontSize: 11 }}>
                  {c.rule}
                </span>
              </span>
              <Amount total={c.upload} rate={c.closedAt ? 0 : c.uploadRate} />
              <Amount total={c.download} rate={c.closedAt ? 0 : c.downloadRate} />
              <span className="r">{c.closedAt ? clock(c.closedAt) : duration(now - new Date(c.createdAt).getTime())}</span>
              {tab === "open" ? (
                <button
                  className="btn ghost icon x"
                  title="断开"
                  aria-label={`断开 ${c.domain || c.destination}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    await box.closeConnection(c.id);
                    refresh();
                  }}
                >
                  <X size={14} />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
          {list.length === 0 && (
            <p className="placeholder" style={{ padding: "18px 28px" }}>
              {q ? "没有匹配的连接。" : tab === "closed" ? "还没有已结束的连接。内核运行期间结束的连接会留在这里（最多 3000 条）。" : "还没有连接。把应用的代理设为内核的入站地址后，连接会出现在这里。"}
            </p>
          )}
        </div>
      )}
      <ConnectionDetail conn={detail} onClose={() => setDetail(null)} />
    </>
  );
}

/** A total, with its rate of the last second below while it moves. */
function Amount({ total, rate: perSecond }: { total: number; rate: number }) {
  return (
    <span className="r" style={{ display: "flex", flexDirection: "column" }}>
      <span>{bytes(total)}</span>
      {perSecond > 0 && <span className="faint" style={{ fontSize: 10.5 }}>{rate(perSecond)}</span>}
    </span>
  );
}

/** The keys of a list, with how many items each has, most first, and a program's path for its icon. */
function countBy(list: Connection[], key: (c: Connection) => string): { key: string; count: number; path?: string }[] {
  const counts = new Map<string, { count: number; path?: string }>();
  for (const c of list) {
    const g = counts.get(key(c)) ?? { count: 0, path: c.processPath };
    g.count++;
    counts.set(key(c), g);
  }
  return [...counts].map(([k, g]) => ({ key: k, ...g })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function Toolbar({
  tab,
  setTab,
  query,
  setQuery,
  children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  query: string;
  setQuery: (q: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="subbar">
      <ToggleGroup.Root className="segmented" type="single" value={tab} onValueChange={(v) => v && setTab(v as Tab)} aria-label="连接">
        <ToggleGroup.Item value="open">活动</ToggleGroup.Item>
        <ToggleGroup.Item value="closed">已结束</ToggleGroup.Item>
        <ToggleGroup.Item value="dns">DNS</ToggleGroup.Item>
        <ToggleGroup.Item value="activity">内核活动</ToggleGroup.Item>
      </ToggleGroup.Root>
      <label className="field" style={{ width: 240 }}>
        <Search size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索域名、地址、进程、规则" aria-label="搜索" onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
      </label>
      <div className="end">{children}</div>
    </div>
  );
}

const kinds: { value: ActivityKind | ""; label: string }[] = [
  { value: "", label: "全部" },
  { value: "dns", label: "DNS" },
  { value: "rule-set", label: "规则集" },
  { value: "urltest", label: "测速" },
  { value: "ntp", label: "时间" },
  { value: "route", label: "拒绝/劫持" },
];

/** The core's own network work, from its log, at every level. */
function ActivityList({ query }: { query: string }) {
  const [kind, setKind] = useState<ActivityKind | "">("");
  const [list, setList] = useState<Activity[]>([]);
  useEffect(() => {
    let live = true;
    let pending = false;
    let again = false;
    const load = () => {
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      box
        .activity(kind as ActivityKind, query)
        .then((l) => live && setList(l), () => {})
        .finally(() => {
          pending = false;
          if (again && live) {
            again = false;
            load();
          }
        });
    };
    load();
    const off = events.logs.on(load);
    return () => {
      live = false;
      off();
    };
  }, [kind, query]);
  const counts = useMemo(() => list.length, [list]);
  return (
    <div>
      <div className="subbar" style={{ borderTop: 0, paddingTop: 0 }}>
        <ToggleGroup.Root className="segmented" type="single" value={kind || "all"} onValueChange={(v) => v && setKind(v === "all" ? "" : (v as ActivityKind))} aria-label="类别">
          {kinds.map((k) => (
            <ToggleGroup.Item key={k.label} value={k.value || "all"}>
              {k.label}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <span className="faint" style={{ fontSize: 12 }}>
          {counts} 条
        </span>
        <div className="end">
          <button className="btn ghost" onClick={() => box.clearActivity()}>
            清空
          </button>
        </div>
      </div>
      {list.length === 0 ? (
        <p className="placeholder" style={{ padding: "18px 28px", maxWidth: 680 }}>
          这里记录不属于连接的内核联网：DNS 查询、远程规则集下载、urltest 自动测速、时间同步，以及被拒绝或劫持的连接。它们来自内核日志（不受日志级别影响）；配置里 log.disabled 为 true 时这里为空。
        </p>
      ) : (
        <div className="logs selectable">
          {list.map((a, i) => (
            <div className="log activity" key={i}>
              <time>{clock(a.time)}</time>
              <span className={`lvl ${a.level}`}>{kinds.find((k) => k.value === a.kind)?.label}</span>
              <span className="msg">{a.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionDetail({ conn, onClose }: { conn: Connection | null; onClose: () => void }) {
  const rows: [string, string | undefined][] = conn
    ? [
        ["序号", `#${conn.seq}${conn.logId ? ` · 日志编号 ${conn.logId}` : ""}${conn.flow ? " · TUN 预匹配" : ""}`],
        ["失败", conn.error],
        ["目标", conn.domain ? `${conn.domain}（${conn.destination}）` : conn.destination],
        ["原始目标", conn.originDestination ? `${conn.originDestination}${conn.fakeIp ? "（FakeIP）" : ""}` : conn.fakeIp ? "FakeIP" : undefined],
        ["解析地址", conn.addresses.length ? conn.addresses.join("、") : undefined],
        ["来源", conn.source],
        ["进程", conn.processPath ? `${conn.processPath}${conn.processId ? `（PID ${conn.processId}）` : ""}` : undefined],
        ["经由进程", conn.viaPath],
        ["网络", `${conn.network.toUpperCase()}${conn.ipVersion ? ` · IPv${conn.ipVersion}` : ""}`],
        ["嗅探协议", [conn.protocol, conn.client].filter(Boolean).join(" · ") || undefined],
        ["入站", `${conn.inbound}（${conn.inboundType}）`],
        ["用户", conn.user],
        ["规则", conn.rule],
        ["出站", `${conn.chain.join(" → ") || conn.outbound}（${conn.outboundType}）`],
        ["上传", `${bytes(conn.upload)}${!conn.closedAt && conn.uploadRate ? ` · ${rate(conn.uploadRate)}` : ""}`],
        ["下载", `${bytes(conn.download)}${!conn.closedAt && conn.downloadRate ? ` · ${rate(conn.downloadRate)}` : ""}`],
        ["路由用时", conn.routingMs ? `${conn.routingMs} ms（接受连接到规则匹配完成，含嗅探和域名解析，不含握手）` : undefined],
        ["开始", new Date(conn.createdAt).toLocaleString()],
        ["结束", conn.closedAt ? new Date(conn.closedAt).toLocaleString() : "仍在连接"],
      ]
    : [];
  return (
    <Dialog.Root open={!!conn} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" style={{ width: "min(720px, calc(100vw - 48px))", top: "8%", maxHeight: "86vh", overflow: "auto" }}>
          <Dialog.Title asChild>
            <h2 className="ellipsis">{conn?.domain || conn?.destination}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p>连接详情</p>
          </Dialog.Description>
          {conn?.processPath && (
            <div className="detail-proc">
              <ProcessIcon path={conn.processPath} size={20} />
              <span>{conn.process}</span>
            </div>
          )}
          <dl className="details selectable">
            {rows
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          {conn?.logId ? <ConnectionLog logId={conn.logId} /> : null}
          <div className="actions">
            <Dialog.Close asChild>
              <button className="btn">关闭</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Every line the core logged for a connection, at every level. */
function ConnectionLog({ logId }: { logId: number }) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => box.connectionLogs(logId).then((l) => live && setLines(l), () => {});
    load();
    const off = events.logs.on(load);
    return () => {
      live = false;
      off();
    };
  }, [logId]);
  return (
    <div className="conn-log">
      <div className="faint" style={{ fontSize: 12, margin: "12px 0 4px" }}>
        这个连接的内核日志（所有级别，不受日志级别限制）
      </div>
      {lines && lines.length === 0 ? (
        <p className="faint" style={{ fontSize: 12 }}>
          没有记录。日志按连接保留最近 4000 个，较早的连接已被清掉。
        </p>
      ) : (
        <div className="logs selectable">
          {(lines ?? []).map((l, i) => (
            <div className="log" key={i}>
              <time>{clock(l.time)}</time>
              <span className={`lvl ${l.level}`}>{l.level}</span>
              <span className="msg">{l.message.replace(/^\[\d+ [^\]]*\] /, "")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const dnsSources: Record<string, string> = {
  exchanged: "查询",
  cached: "缓存",
  optimistic: "过期缓存",
  refreshed: "刷新",
  rejected: "拒绝",
  failed: "失败",
};

/** What a DNS server is, as the Surge-like page names it. */
function serverKind(type?: string): string {
  switch (type) {
    case "hosts":
      return "本地";
    case "local":
      return "系统";
    case "fakeip":
      return "FakeIP";
    case undefined:
    case "":
      return "";
    default:
      return "远程";
  }
}

/** The DNS queries the core answered, from its log. */
function DNSList({ query, running }: { query: string; running: boolean }) {
  const [list, setList] = useState<DNSRecord[]>([]);
  useEffect(() => {
    let live = true;
    let pending = false;
    const load = () => {
      if (pending) return;
      pending = true;
      box
        .dnsRecords(query, 500)
        .then((l) => live && setList(l), () => {})
        .finally(() => (pending = false));
    };
    // The DNS lines come with the log's events.
    load();
    const off = events.logs.on(load);
    return () => {
      live = false;
      off();
    };
  }, [query]);
  return (
    <div>
      <div className="subbar" style={{ borderTop: 0, paddingTop: 0 }}>
        <span className="faint" style={{ fontSize: 12 }}>
          {list.length} 条 · 来自内核的 DNS 日志
        </span>
        <div className="end">
          <button
            className="btn ghost"
            disabled={!running}
            onClick={async () => {
              try {
                await box.clearDNSCache();
                toast.success("已清空内核的 DNS 缓存");
              } catch (err) {
                toast.error("没能清空 DNS 缓存", { description: errorText(err) });
              }
            }}
            title="清空内核的 DNS 缓存，之后的查询重新向服务器请求。不会清空 macOS 自己的 DNS 缓存。"
          >
            清除 DNS 缓存
          </button>
          <button className="btn ghost" onClick={() => box.clearDNSRecords()}>
            清空记录
          </button>
        </div>
      </div>
      <div style={{ padding: "0 24px 0 28px" }}>
        <DNSQuery running={running} />
      </div>
      {list.length === 0 ? (
        <p className="placeholder" style={{ padding: "18px 28px", maxWidth: 680 }}>
          {query ? "没有匹配的查询。" : "内核运行后，每次 DNS 查询（应用的查询，以及内核为连接解析域名）都会出现在这里：结果、走的服务器、是否来自缓存。"}
        </p>
      ) : (
        <div className="table dns-table">
          <div className="thead">
            <span>时间</span>
            <span>域名</span>
            <span>结果</span>
            <span>服务器</span>
            <span>来源</span>
          </div>
          {list.map((r, i) => (
            <div className={`trow${r.source === "failed" ? " failed" : ""}`} key={i}>
              <span className="faint">{clock(r.time)}</span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span className="host" title={r.domain}>
                  {r.domain}
                </span>
                <span className="faint" style={{ fontSize: 11 }}>
                  {[r.type, r.rcode && r.rcode !== "NOERROR" ? r.rcode : "", r.ttl ? `TTL ${r.ttl}s` : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="ellipsis selectable mono" title={r.error || r.answers.join("\n")} style={{ fontSize: 11.5 }}>
                {r.error ? <span className="danger-text">{r.error}</span> : r.answers.map((a) => a.replace(/^[A-Z0-9]+ /, "")).join(", ") || <span className="faint">无记录</span>}
              </span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span className="ellipsis">{r.server || "—"}</span>
                <span className="faint" style={{ fontSize: 11 }}>
                  {[serverKind(r.serverType), r.server ? (r.byRule ? "DNS 规则" : "默认") : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className={r.source === "failed" ? "danger-text" : "faint"}>{dnsSources[r.source] ?? r.source}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
