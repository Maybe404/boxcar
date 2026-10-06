import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ToggleGroup } from "radix-ui";
import { Pause, Play, Search } from "lucide-react";
import { toast } from "sonner";
import { box, errorText, events, type LogLine } from "../api";
import { clock } from "../format";

export type LogLevel = "all" | "debug" | "info" | "warn" | "error";

// How many lines the page shows; the export has them all.
const shown = 1500;

function levelOf(configured?: string): LogLevel {
  switch (configured) {
    case "error":
    case "fatal":
    case "panic":
      return "error";
    case "warn":
      return "warn";
    case "debug":
    case "trace":
      return "debug";
    default:
      return "info";
  }
}

export function LogsPage({ configured }: { configured?: string }) {
  const [level, setLevel] = useState<LogLevel>(() => levelOf(configured));
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // The level the configuration logs at, once it runs.
  const seen = useRef(configured);
  useEffect(() => {
    if (configured && configured !== seen.current) {
      seen.current = configured;
      setLevel(levelOf(configured));
    }
  }, [configured]);

  useEffect(() => {
    if (paused) return;
    let live = true;
    let pending = false;
    let again = false;
    const load = () => {
      // One request at a time; lines that come meanwhile load right after.
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      box
        .logs(level, query, shown)
        .then((l) => live && setLines(l), () => {})
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
  }, [level, query, paused]);

  // Follow the end, unless scrolled away from it.
  useLayoutEffect(() => {
    const el = ref.current?.closest(".page");
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  useEffect(() => {
    const el = ref.current?.closest(".page");
    if (!el) return;
    const on = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener("scroll", on);
    return () => el.removeEventListener("scroll", on);
  }, []);

  const exportLogs = async () => {
    try {
      const path = await box.exportLogs(level, query);
      if (path) toast.success("日志已导出", { description: path });
    } catch (err) {
      toast.error("导出失败", { description: errorText(err) });
    }
  };

  return (
    <div ref={ref}>
      <div className="subbar sticky">
        <ToggleGroup.Root className="segmented" type="single" value={level} onValueChange={(v) => v && setLevel(v as LogLevel)} aria-label="日志级别">
          <ToggleGroup.Item value="error">错误</ToggleGroup.Item>
          <ToggleGroup.Item value="warn">警告</ToggleGroup.Item>
          <ToggleGroup.Item value="info">信息</ToggleGroup.Item>
          <ToggleGroup.Item value="debug">调试</ToggleGroup.Item>
        </ToggleGroup.Root>
        <label className="field" style={{ width: 220 }}>
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索日志" aria-label="搜索日志" onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
        </label>
        <div className="end">
          <button className="btn ghost" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
            {paused ? "继续" : "暂停"}
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(lines.map((l) => `${clock(l.time)} ${l.level.toUpperCase()} ${l.message}`).join("\n"));
              toast.success(`已复制 ${lines.length} 行`);
            }}
          >
            复制
          </button>
          <button className="btn ghost" onClick={exportLogs}>
            导出…
          </button>
          <button className="btn ghost" onClick={() => box.clearLogs()}>
            清空
          </button>
        </div>
      </div>
      {lines.length === 0 ? (
        <div className="empty" style={{ height: "auto", paddingTop: 80 }}>
          <h2>{query ? "没有匹配的日志" : "暂无日志"}</h2>
          <p>{query ? "换个关键词，或调低日志级别。" : "启动内核后，它的日志会实时显示在这里。"}</p>
        </div>
      ) : (
        <div className="logs selectable">
          {lines.map((l, i) => (
            <div className="log" key={i}>
              <time>{clock(l.time)}</time>
              <span className={`lvl ${l.level}`}>{l.level}</span>
              <span className="msg">{l.message}</span>
            </div>
          ))}
          {paused && <div className="placeholder" style={{ padding: "8px 28px" }}>已暂停，新日志在继续后显示。</div>}
        </div>
      )}
    </div>
  );
}
