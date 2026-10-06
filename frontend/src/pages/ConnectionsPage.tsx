// Every connection sing-box routed, open and closed, recorded as the
// router hands it on so that none is missed; and the core's own network
// work that is not a routed connection: DNS, rule-sets, URL tests, NTP,
// rejected and hijacked connections.
import { useEffect, useMemo, useState } from "react";
import { Dialog, ToggleGroup } from "radix-ui";
import { Search, X } from "lucide-react";
import { box, events, type Activity, type ActivityKind, type Connection, type Snapshot } from "../api";
import { bytes, clock, duration } from "../format";
import { useNow, usePoll } from "../hooks";
import { Route } from "../components/Route";
import { Stopped } from "../components/Stopped";

type Tab = "open" | "closed" | "activity";
type Sort = "time" | "traffic" | "host";

export function ConnectionsPage({ snap }: { snap: Snapshot }) {
  const running = snap.status === "running";
  const [tab, setTab] = useState<Tab>("open");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("time");
  const [detail, setDetail] = useState<Connection | null>(null);
  const now = useNow(tab !== "activity");
  const [conns, refresh] = usePoll<Connection[]>(() => box.connections(tab === "closed"), 1000, tab !== "activity", [], [tab]);

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
  if (sort === "traffic") list = [...list].sort((a, b) => b.upload + b.download - (a.upload + a.download));
  if (sort === "host") list = [...list].sort((a, b) => (a.domain || a.destination).localeCompare(b.domain || b.destination));

  return (
    <>
      <Toolbar tab={tab} setTab={setTab} query={query} setQuery={setQuery}>
        {tab !== "activity" && (
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
      ) : (
        <div className="table">
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
            <div className="trow" key={c.id} onClick={() => setDetail(c)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setDetail(c)}>
              <span className="net">{c.network.toUpperCase()}</span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span className="host" title={c.destination}>
                  {c.domain || c.destination}
                </span>
                {c.process && <span className="faint ellipsis" style={{ fontSize: 11 }}>{c.process}</span>}
              </span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <Route chain={c.chain} inbound={c.inbound} outbound={c.outbound} />
                <span className="faint ellipsis" style={{ fontSize: 11 }}>
                  {c.rule}
                </span>
              </span>
              <span className="r">{bytes(c.upload)}</span>
              <span className="r">{bytes(c.download)}</span>
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
        ["目标", conn.domain ? `${conn.domain}（${conn.destination}）` : conn.destination],
        ["来源", conn.source],
        ["进程", conn.processPath ? `${conn.processPath}${conn.processId ? `（PID ${conn.processId}）` : ""}` : undefined],
        ["网络", `${conn.network.toUpperCase()}${conn.ipVersion ? ` · IPv${conn.ipVersion}` : ""}`],
        ["嗅探协议", conn.protocol],
        ["入站", `${conn.inbound}（${conn.inboundType}）`],
        ["用户", conn.user],
        ["规则", conn.rule],
        ["出站", `${conn.chain.join(" → ") || conn.outbound}（${conn.outboundType}）`],
        ["上传", bytes(conn.upload)],
        ["下载", bytes(conn.download)],
        ["开始", new Date(conn.createdAt).toLocaleString()],
        ["结束", conn.closedAt ? new Date(conn.closedAt).toLocaleString() : "仍在连接"],
      ]
    : [];
  return (
    <Dialog.Root open={!!conn} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" style={{ width: "min(560px, calc(100vw - 48px))", top: "14%" }}>
          <Dialog.Title asChild>
            <h2 className="ellipsis">{conn?.domain || conn?.destination}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p>连接详情</p>
          </Dialog.Description>
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
