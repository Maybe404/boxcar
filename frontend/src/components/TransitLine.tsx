// The line: the way traffic takes through the core, drawn as a transit
// line. Termini are bars, inbounds stations, groups interchanges, the node
// chosen a filled stop. While the core runs, light flows along it, as fast
// and as dense as the traffic.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Popover } from "radix-ui";
import { Copy, Zap } from "lucide-react";
import { toast } from "sonner";
import { box, errorText, type OutboundGroup, type Snapshot, type Station } from "../api";
import { rate } from "../format";
import { useReducedMotion } from "../hooks";

const Y = 58;
const PAD = 72;

interface Props {
  snap: Snapshot;
  groups: OutboundGroup[];
  onGroupsChanged: () => void;
}

export function TransitLine({ snap, groups, onGroupsChanged }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const running = snap.status === "running";
  const reduced = useReducedMotion();

  // Several inbounds share one station, which lists them.
  const { stations, inbounds } = useMemo(() => {
    const inbounds = snap.line.filter((s) => s.kind === "inbound");
    const stations: Station[] = [];
    for (const s of snap.line) {
      if (s.kind === "inbound") {
        if (s === inbounds[0]) stations.push(inbounds.length > 1 ? { ...s, detail: `${inbounds.length} 个入站` } : s);
      } else stations.push(s);
    }
    return { stations, inbounds };
  }, [snap.line]);

  const xs = stations.map((_, i) => PAD + ((width - PAD * 2) * i) / Math.max(1, stations.length - 1));
  const x0 = xs[0] ?? PAD;
  const xN = xs.at(-1) ?? width - PAD;
  const nodeIndex = stations.findIndex((s) => s.kind === "node");
  const lastIndex = stations.length - 1;
  // The rates sit on the track toward the internet.
  const rateX = nodeIndex >= 0 ? (xs[nodeIndex] + xN) / 2 : (xs[lastIndex - 1] + xN) / 2;

  // The line draws itself from the device to the internet as the core
  // starts: the one moment of the window.
  const [drawKey, setDrawKey] = useState(0);
  const prev = useRef(snap.status);
  useEffect(() => {
    if (prev.current !== "running" && snap.status === "running") setDrawKey((k) => k + 1);
    prev.current = snap.status;
  }, [snap.status]);

  const ink = running ? "var(--line)" : "var(--line-dim)";
  const groupOf = (tag: string) => groups.find((g) => g.tag === tag);

  return (
    <div className="transit" ref={ref}>
      <svg width={width} height={150} aria-hidden="true">
        <line x1={x0} x2={xN} y1={Y} y2={Y} stroke="var(--line-dim)" strokeWidth={running ? 0 : 3} strokeLinecap="round" />
        {running && (
          <motion.line
            key={drawKey}
            x1={x0}
            x2={xN}
            y1={Y}
            y2={Y}
            stroke="var(--line)"
            strokeWidth={5}
            strokeLinecap="round"
            initial={{ pathLength: drawKey > 0 && !reduced ? 0 : 1 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
        {running && !reduced && (
          <Pulses key={`d${drawKey}-${Math.round(width)}-${level(snap.stats.downloadRate)}`} from={xN} to={x0} rate={snap.stats.downloadRate} strong delay={drawKey > 0 ? 1.1 : 0} />
        )}
        {running && !reduced && (
          <Pulses key={`u${drawKey}-${Math.round(width)}-${level(snap.stats.uploadRate)}`} from={x0} to={xN} rate={snap.stats.uploadRate} delay={drawKey > 0 ? 1.1 : 0} />
        )}
        {stations.map((s, i) => (
          <motion.g
            key={`${s.kind}-${s.title}`}
            initial={false}
            animate={{ opacity: 1 }}
            transition={{ delay: drawKey > 0 && !reduced ? (i / Math.max(1, lastIndex)) * 0.9 : 0 }}
          >
            <Marker kind={s.kind} x={xs[i]} ink={ink} running={running} />
          </motion.g>
        ))}
      </svg>

      {running && (
        <div className="rates num" style={{ position: "absolute", left: rateX, top: 16, transform: "translateX(-50%)" }}>
          <span>↓ {rate(snap.stats.downloadRate)}</span>
          <span className="faint">↑ {rate(snap.stats.uploadRate)}</span>
        </div>
      )}

      {stations.map((s, i) => {
        const style = { left: xs[i], top: Y + 20 };
        const label = (
          <>
            <span className="name">{s.title}</span>
            {s.detail && <span className="detail">{s.detail}</span>}
          </>
        );
        if (s.kind === "inbound") {
          return (
            <InboundStation key={i} style={style} inbounds={inbounds}>
              {label}
            </InboundStation>
          );
        }
        if (s.kind === "group" || s.kind === "node") {
          // A node opens the group that chose it.
          const tag = s.kind === "group" ? s.title : stations[i - 1]?.title;
          return (
            <GroupStation key={i} style={style} className={s.kind} group={groupOf(tag)} tag={tag} running={running} onChanged={onGroupsChanged}>
              {label}
            </GroupStation>
          );
        }
        return (
          <div key={i} className="station" style={style}>
            {label}
          </div>
        );
      })}
    </div>
  );
}

function Marker({ kind, x, ink, running }: { kind: Station["kind"]; x: number; ink: string; running: boolean }) {
  switch (kind) {
    case "device":
    case "internet":
      return <rect x={x - 3.5} y={Y - 13} width={7} height={26} rx={3.5} fill={ink} />;
    case "group":
      return <rect x={x - 13} y={Y - 8.5} width={26} height={17} rx={8.5} fill="var(--bg)" stroke={ink} strokeWidth={3} />;
    case "node":
      return (
        <>
          {running && <circle cx={x} cy={Y} r={15} fill="var(--line-soft)" />}
          <circle cx={x} cy={Y} r={9.5} fill={running ? "var(--line)" : "var(--bg)"} stroke={running ? "var(--bg)" : ink} strokeWidth={3} />
        </>
      );
    default:
      return <circle cx={x} cy={Y} r={7} fill="var(--bg)" stroke={ink} strokeWidth={3} />;
  }
}

/** The step of a rate the pulses follow: 0 below 512 B/s, up to 4. */
function level(r: number): number {
  return r < 512 ? -1 : Math.min(4, Math.floor(Math.log10(r / 512)));
}

/**
 * Pulses of light along the line: more and faster as the rate grows. They
 * change only with the rate's step, so that they flow on smoothly, and
 * appear once the line has drawn itself.
 */
function Pulses({ from, to, rate: r, strong, delay }: { from: number; to: number; rate: number; strong?: boolean; delay: number }) {
  const l = level(r);
  if (l < 0) return null;
  const count = 1 + l;
  const dur = 5.2 - l * 0.9;
  const path = `M ${from} ${Y} H ${to}`;
  return (
    <g style={delay > 0 ? { opacity: 0, animation: `fade-in 0.3s ${delay}s forwards` } : undefined}>
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} r={strong ? 2.6 : 1.8} fill="#ffffff" opacity={strong ? 0.95 : 0.6}>
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={`${(-dur / count) * i}s`} />
        </circle>
      ))}
    </g>
  );
}

function GroupStation({
  style,
  className,
  group,
  tag,
  running,
  onChanged,
  children,
}: {
  style: React.CSSProperties;
  className: string;
  group?: OutboundGroup;
  tag: string;
  running: boolean;
  onChanged: () => void;
  children: React.ReactNode;
}) {
  const [testing, setTesting] = useState(false);
  const select = async (item: string) => {
    try {
      await box.select(tag, item);
      onChanged();
    } catch (err) {
      toast.error(errorText(err));
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      await box.urlTest(tag);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setTesting(false);
      onChanged();
    }
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={`station ${className}`} style={style}>
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" sideOffset={6} collisionPadding={12}>
          <div className="menu-label" style={{ display: "flex", alignItems: "center" }}>
            <span>
              {tag}
              {group && <span style={{ fontWeight: 400 }}> · {group.selectable ? "手动选择" : "自动选择延迟最低的节点"}</span>}
            </span>
            {group && (
              <button className="btn ghost icon" style={{ marginLeft: "auto", height: 22, width: 22 }} title="测速" disabled={testing} onClick={test}>
                <Zap size={13} />
              </button>
            )}
          </div>
          {!running && <div className="placeholder" style={{ padding: "6px 9px 8px" }}>启动后可以在这里切换节点。</div>}
          {group?.items.map((it) => (
            <div
              key={it.tag}
              className="menu-item"
              role="menuitemradio"
              aria-checked={it.tag === group.selected}
              aria-disabled={!group.selectable}
              tabIndex={group.selectable ? 0 : -1}
              onClick={() => group.selectable && it.tag !== group.selected && select(it.tag)}
              onKeyDown={(e) => e.key === "Enter" && group.selectable && select(it.tag)}
              style={{ cursor: group.selectable ? "default" : "not-allowed" }}
            >
              <span className="dot" style={it.tag === group.selected ? { background: "currentColor" } : { background: "transparent", boxShadow: "inset 0 0 0 1.5px var(--line-dim)" }} />
              <span style={{ fontWeight: it.tag === group.selected ? 650 : 400 }}>{it.tag}</span>
              <span className="end muted num" style={{ fontSize: 12 }}>
                {it.delay > 0 ? `${it.delay} ms` : it.type}
              </span>
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function InboundStation({ style, inbounds, children }: { style: React.CSSProperties; inbounds: Station[]; children: React.ReactNode }) {
  const copy = (s: Station) => {
    const m = /^([\w-]+) · (.*):(\d+)$/.exec(s.detail ?? "");
    if (!m) return;
    const [, type, listen, port] = m;
    // Listening on every address, the proxy is reached on this Mac's own.
    let host = !listen || listen === "::" || listen === "0.0.0.0" ? "127.0.0.1" : listen;
    if (host.includes(":")) host = `[${host}]`;
    const http = type === "socks" ? "" : `http_proxy=http://${host}:${port} https_proxy=http://${host}:${port} `;
    const socks = type === "http" ? "" : `all_proxy=socks5://${host}:${port}`;
    navigator.clipboard.writeText(`export ${http}${socks}`.trim());
    toast.success("已复制终端代理命令", { description: "粘贴到终端，让命令行程序走代理。" });
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="station" style={style}>
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" sideOffset={6} collisionPadding={12}>
          <div className="menu-label">入站 · 应用把代理设到这些地址</div>
          {inbounds.map((s) => {
            const proxy = /^(mixed|http|socks) · /.test(s.detail ?? "");
            return (
              <div key={s.title} className="menu-item" tabIndex={0} onClick={() => proxy && copy(s)} onKeyDown={(e) => e.key === "Enter" && proxy && copy(s)}>
                <span>{s.title}</span>
                <span className="end muted mono">{s.detail}</span>
                {proxy && <Copy size={12} className="muted" />}
              </div>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
