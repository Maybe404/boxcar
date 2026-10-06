// The visual editor of a configuration: the wizards of the common parts,
// and the form of every field by section. It edits the same text as the
// JSON editor: every change here is written back to it, and a change there
// shows here.
import { useEffect, useMemo, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { ChevronDown, CircleAlert, MessageSquareWarning, X } from "lucide-react";
import { hasComments, parseConfig, stringifyConfig } from "./jsonc";
import { checkRefs, placeOf } from "./refs";
import { schema, shapeOf, type Node } from "./schema";
import { sectionContexts } from "./docs";
import { FormContext, ObjectFields, ObjectList, RawValue } from "./SchemaForm";
import { NodesPane } from "./NodesPane";
import { InboundsPane } from "./InboundsPane";
import { GroupsPane } from "./GroupsPane";
import { RulesPane } from "./RulesPane";
import { RuleSetsPane } from "./RuleSetsPane";
import { DNSPane } from "./DNSPane";
import type { Runtime } from "./common";
import "./config.css";
import { getIn, isObject, parsePath, setIn, type Json, type Path } from "./path";

export const wizardTabs = [
  { id: "nodes", title: "节点" },
  { id: "inbounds", title: "本地端口" },
  { id: "groups", title: "策略组" },
  { id: "rules", title: "分流规则" },
  { id: "rulesets", title: "规则集" },
  { id: "dns", title: "DNS" },
] as const;

/** The sections of a configuration, in the app's words. */
export const fullSections: [string, string][] = [
  ["log", "日志"],
  ["dns", "DNS"],
  ["inbounds", "入站"],
  ["outbounds", "出站"],
  ["endpoints", "端点"],
  ["route", "路由"],
  ["services", "服务"],
  ["experimental", "实验功能"],
  ["ntp", "时间同步（NTP）"],
  ["certificate", "证书"],
  ["certificate_providers", "证书提供者"],
  ["http_clients", "HTTP 客户端"],
  ["network_namespaces", "网络命名空间"],
];

type Tab = (typeof wizardTabs)[number]["id"] | `full:${string}`;

const tabKey = "boxcar.editor.tab";
function savedTab(): Tab {
  try {
    const t = localStorage.getItem(tabKey);
    if (t && (wizardTabs.some((w) => w.id === t) || t.startsWith("full:"))) return t as Tab;
  } catch {
    // No storage: start at the nodes.
  }
  return "nodes";
}

/** The tab where a problem at a path is fixed. */
function tabOf(config: Json, path: Path): Tab {
  const [a, b] = path;
  if (a === "outbounds" && typeof b === "number") {
    const type = getIn(config, [a, b, "type"]);
    return type === "selector" || type === "urltest" ? "groups" : "nodes";
  }
  if (a === "endpoints") return "nodes";
  if (a === "inbounds") return "inbounds";
  if (a === "route" && b === "final") return "groups";
  if (a === "route" && b === "rules") return "rules";
  if (a === "route" && b === "rule_set") return "rulesets";
  if (a === "dns" && (b === "servers" || b === "rules" || b === "final")) return "dns";
  return `full:${a}`;
}

interface Props {
  text: string;
  saved: string;
  onText: (text: string) => void;
  runtime: Runtime;
  /** Problems the last check found, by path. */
  checked?: { path: string; message: string; fatal: boolean }[];
  onShowJSON: () => void;
}

export default function ConfigEditor({ text, saved, onText, runtime, checked, onShowJSON }: Props) {
  const [tab, setTabNow] = useState<Tab>(savedTab);
  const setTab = (t: Tab) => {
    setTabNow(t);
    try {
      localStorage.setItem(tabKey, t);
    } catch {
      // Not remembered.
    }
  };
  // The value written last is the value of the text: no parse needed.
  const last = useRef<{ text: string; value: Json } | null>(null);
  const parsed = useMemo(() => (last.current?.text === text ? { ok: true as const, value: last.current.value } : parseConfig(text)), [text]);
  const config = parsed.ok ? parsed.value : null;
  const onChange = (next: Json) => {
    const t = stringifyConfig(next);
    last.current = { text: t, value: next };
    onText(t);
  };
  const live = useMemo(() => (config ? checkRefs(config) : []), [config]);
  const env = { config, problems: useMemo(() => new Set(live.filter((p) => p.fatal).map((p) => p.path)), [live]), update: onChange };
  const [showProblems, setShowProblems] = useState(false);
  const comments = useMemo(() => hasComments(saved), [saved]);
  const lost = comments && text !== saved && !hasComments(text);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [tab]);

  if (!config) {
    return (
      <div className="empty">
        <h2>JSON 有语法错误</h2>
        <p className="selectable">{parsed.ok ? "" : parsed.error}</p>
        <p>改好之前不能用可视化编辑。</p>
        <button className="btn primary large" onClick={onShowJSON}>
          到 JSON 里修改
        </button>
      </div>
    );
  }

  const full = tab.startsWith("full:") ? tab.slice(5) : null;
  const fullTitle = full ? (fullSections.find(([k]) => k === full)?.[1] ?? full) : null;
  const unknownTop = Object.keys(config).filter((k) => k !== "$schema" && !fullSections.some(([s]) => s === k));
  const problems = checked && checked.length ? checked : live;
  const fatal = problems.filter((p) => p.fatal).length;

  return (
    <FormContext.Provider value={env}>
      <div className="config-editor">
        <nav className="tabs" aria-label="配置的部分">
          {wizardTabs.map((t) => (
            <button key={t.id} className="tab" aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
              {t.title}
            </button>
          ))}
          <span className="tab-sep" />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="tab" aria-current={full ? "page" : undefined}>
                {full ? `全部字段 · ${fullTitle}` : "全部字段"} <ChevronDown size={12} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                <DropdownMenu.Label className="menu-label">每个字段，按配置的分区</DropdownMenu.Label>
                {fullSections.map(([k, title]) => (
                  <DropdownMenu.Item key={k} className="menu-item" onSelect={() => setTab(`full:${k}`)}>
                    {title}
                    <span className="end muted mono">{k}</span>
                  </DropdownMenu.Item>
                ))}
                {unknownTop.length > 0 && (
                  <DropdownMenu.Item className="menu-item" onSelect={() => setTab("full:__other")}>
                    其他
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </nav>

        {(problems.length > 0 || comments) && (
          <div className="editor-notes">
            {problems.length > 0 && (
              <div className={`note${fatal ? " bad" : ""}`}>
                <CircleAlert size={14} />
                <span>
                  {fatal ? `${fatal} 处引用有问题，启动时会失败` : ""}
                  {fatal && problems.length > fatal ? "；" : ""}
                  {problems.length > fatal ? `${problems.length - fatal} 处引用不存在，不影响启动` : ""}。
                  <button className="link-inline" onClick={() => setShowProblems(!showProblems)}>
                    {showProblems ? "收起" : "查看"}
                  </button>
                </span>
              </div>
            )}
            {showProblems && problems.length > 0 && (
              <ul className="problems">
                {problems.map((p, i) => {
                  const path = parsePath(p.path);
                  return (
                    <li key={i}>
                      <button className={`problem${p.fatal ? "" : " mild"}`} onClick={() => setTab(tabOf(config, path))}>
                        <b>{placeOf(config, path)}</b>
                        <span>{p.message}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {comments && (
              <div className="note">
                <MessageSquareWarning size={14} />
                <span>{lost ? "注释已去掉：可视化编辑按标准 JSON 写回，保存后注释不再保留。不想要这些修改可以点「还原」。" : "这个配置里有注释。在这里修改后会按标准 JSON 写回，注释会丢失。"}</span>
              </div>
            )}
          </div>
        )}

        <div className="editor-scroll" ref={scroller}>
          {tab === "nodes" && <NodesPane config={config} onChange={onChange} runtime={runtime} />}
          {tab === "inbounds" && <InboundsPane config={config} onChange={onChange} runtime={runtime} />}
          {tab === "groups" && <GroupsPane config={config} onChange={onChange} runtime={runtime} />}
          {tab === "rules" && <RulesPane config={config} onChange={onChange} runtime={runtime} />}
          {tab === "rulesets" && <RuleSetsPane config={config} onChange={onChange} runtime={runtime} />}
          {tab === "dns" && <DNSPane config={config} onChange={onChange} runtime={runtime} />}
          {full && full !== "__other" && <FullSection key={full} name={full} title={fullTitle!} config={config} onChange={onChange} />}
          {full === "__other" && (
            <div className="pane">
              <header className="pane-head">
                <div className="what">
                  <h3>其他</h3>
                  <p>表单不认识的顶层字段，原样保留。</p>
                </div>
              </header>
              {unknownTop.map((k) => (
                <div className="f-row" key={k}>
                  <div className="f-head">
                    <code className="f-key strong">{k}</code>
                    <button className="f-clear" title="删除这个字段" onClick={() => onChange(setIn(config, [k], undefined))}>
                      <X size={12} />
                    </button>
                  </div>
                  <RawValue value={config[k]} onChange={(v) => onChange(setIn(config, [k], v))} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </FormContext.Provider>
  );
}

/** A section of the configuration, every field of it. */
function FullSection({ name, title, config, onChange }: { name: string; title: string; config: Json; onChange: (next: Json) => void }) {
  const node = (schema.properties as Record<string, Node>)[name];
  const shape = shapeOf(node);
  const value = config[name];
  const set = (v: Json) => onChange(setIn(config, [name], v === undefined || (isObject(v) && Object.keys(v).length === 0) ? undefined : v));
  return (
    <div className="pane">
      <header className="pane-head">
        <div className="what">
          <h3>
            {title} <code className="f-key">{name}</code>
          </h3>
          <p>{shape.kind === "array" ? "列表里的每一项都可以展开编辑；添加时先选类型。" : "已设置的字段在前，其余可选字段可以展开。"}字段说明来自内核文档。</p>
        </div>
      </header>
      {shape.kind === "array" ? (
        <ObjectList items={shape.items} value={value} onChange={set} contexts={sectionContexts(name)} path={[name]} section={name} />
      ) : (
        <ObjectFields node={node} value={value ?? {}} onChange={set} contexts={sectionContexts(name)} path={[name]} section={name} />
      )}
    </div>
  );
}
