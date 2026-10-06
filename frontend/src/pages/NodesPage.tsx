// Every group is a line of its own, its outbounds the stops along it; the
// stop chosen is filled. A click on a stop of a selector switches to it.
import { useEffect, useMemo, useRef, useState } from "react";
import { Zap } from "lucide-react";
import { toast } from "sonner";
import { box, errorText, type OutboundGroup, type Snapshot } from "../api";
import { Stopped } from "../components/Stopped";

interface Props {
  snap: Snapshot;
  groups: OutboundGroup[];
  refresh: () => void;
  query: string;
}

export function NodesPage({ snap, groups, refresh, query }: Props) {
  if (snap.status !== "running") {
    return <Stopped title="内核未运行" detail="启动后，这里会列出配置里的策略组，可以切换节点、测试延迟。" status={snap.status} profile={snap.profile} />;
  }
  if (groups.length === 0) {
    return (
      <div className="empty">
        <h2>没有策略组</h2>
        <p>当前配置里没有 selector 或 urltest 类型的出站，流量直接走{snap.line.find((s) => s.kind === "node")?.title ?? "默认出站"}。</p>
      </div>
    );
  }
  return (
    <div className="nodes-page">
      {groups.map((g) => (
        <Group key={g.tag} group={g} refresh={refresh} query={query} />
      ))}
    </div>
  );
}

function Group({ group, refresh, query }: { group: OutboundGroup; refresh: () => void; query: string }) {
  const [testing, setTesting] = useState(false);
  const [testingOne, setTestingOne] = useState<Set<string>>(new Set());
  const [just, setJust] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? group.items.filter((it) => it.tag.toLowerCase().includes(q) || it.type.includes(q)) : group.items;
  }, [group.items, query]);
  if (items.length === 0) return null;

  const select = async (tag: string) => {
    try {
      await box.select(group.tag, tag);
      // The stop switched to stays lit until it has been seen.
      setJust(tag);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setJust(""), 2400);
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      await box.urlTest(group.tag);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setTesting(false);
      refresh();
    }
  };
  // One stop's delay, measured through sing-box.
  const testOne = async (tag: string) => {
    setTestingOne((s) => new Set(s).add(tag));
    try {
      await box.testOutbound(tag);
    } catch (err) {
      toast.error(`${tag} 测速失败`, { description: errorText(err) });
    } finally {
      setTestingOne((s) => {
        const next = new Set(s);
        next.delete(tag);
        return next;
      });
      refresh();
    }
  };
  const tested = group.items.filter((it) => it.delay > 0);
  const best = tested.length ? Math.min(...tested.map((it) => it.delay)) : 0;

  return (
    <section className={`group${group.selectable ? "" : " auto"}`}>
      <header className="group-head">
        <h2>{group.tag}</h2>
        <span className="meta">
          {group.selectable ? "手动选择" : "自动选择延迟最低的节点"} · {group.items.length} 个节点
          {best > 0 && <> · 最快 {best} ms</>}
        </span>
        <div className="tools">
          <button className="btn ghost" onClick={test} disabled={testing}>
            <Zap size={13} />
            {testing ? "正在测速…" : "测速"}
          </button>
        </div>
      </header>
      <ul className="stops" role={group.selectable ? "radiogroup" : "list"} aria-label={group.tag}>
        {items.map((it) => {
          const selected = it.tag === group.selected;
          const cls = `stop${selected ? " selected" : ""}${just === it.tag ? " just" : ""}`;
          const body = (
            <>
              <span className="pin" />
              <span className="label">
                <b>{it.tag}</b>
                <span>{it.type}</span>
              </span>
              <span
                className={`delay${it.delay >= 800 ? " slow" : ""}`}
                role="button"
                tabIndex={0}
                title="单独测速"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!testingOne.has(it.tag)) testOne(it.tag);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    testOne(it.tag);
                  }
                }}
              >
                {testingOne.has(it.tag) ? "…" : it.delay > 0 ? `${it.delay} ms` : "测速"}
              </span>
            </>
          );
          return (
            <li key={it.tag}>
              {group.selectable ? (
                <button className={cls} role="radio" aria-checked={selected} onClick={() => !selected && select(it.tag)}>
                  {body}
                </button>
              ) : (
                <div className={cls} title="自动选择的策略组无法手动切换">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
