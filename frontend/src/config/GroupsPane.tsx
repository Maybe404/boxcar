// Groups: selectors, switched by hand, and urltests, which choose the
// fastest themselves; and the default outbound, where traffic no rule
// matches goes.
import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { DeleteDialog, digits, EditDialog, Empty, ItemMenu, More, PaneHead, Row, type PaneProps } from "./common";
import { FormContext, ObjectFields, RefSelect } from "./SchemaForm";
import { def } from "./schema";
import { sectionContexts } from "./docs";
import { addItem, duplicateItem, isGroup, itemsOf, removeItem, replaceItem, uniqueTag } from "./ops";
import { tagsOf, tagsOfItem } from "./refs";
import { getIn, omitKeys, setIn, type Json } from "./path";

const intervals = [
  { value: "1m", name: "每 1 分钟" },
  { value: "3m", name: "每 3 分钟（默认）" },
  { value: "5m", name: "每 5 分钟" },
  { value: "10m", name: "每 10 分钟" },
  { value: "30m", name: "每 30 分钟" },
];

const testURLs = ["https://www.gstatic.com/generate_204", "https://cp.cloudflare.com/generate_204", "https://www.apple.com/library/test/success.html"];

export function GroupsPane({ config, onChange }: PaneProps) {
  const outbounds = itemsOf(config, ["outbounds"]);
  const groups = outbounds.map((item, index) => ({ item, index })).filter(({ item }) => isGroup(item));
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const final = getIn(config, ["route", "final"]);
  const firstOutbound = tagsOf(config, "outbound")[0];

  return (
    <div className="pane">
      <PaneHead title="策略组" detail="把几个节点放在一组：手动选择用哪个，或自动选延迟最低的。">
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={13} /> 新建策略组
        </button>
      </PaneHead>

      <FormContext.Provider value={{ config, problems: new Set() }}>
        <div className="f-row inline final-row">
          <div className="f-main">
            <div className="f-head">
              <span className="f-label">默认出站</span>
              <code className="f-key">route.final</code>
            </div>
            <div className="f-desc">没有匹配任何分流规则的流量走这里。不设置时用第一个出站{firstOutbound ? `（${firstOutbound}）` : ""}。</div>
          </div>
          <RefSelect kind="outbound" value={final} onChange={(v) => onChange(setIn(config, ["route", "final"], v))} placeholder={`（第一个出站${firstOutbound ? `：${firstOutbound}` : ""}）`} />
        </div>
      </FormContext.Provider>

      {groups.length === 0 ? (
        <Empty title="还没有策略组">新建一个「手动选择」组，把节点放进去，再把它设为默认出站，就能在「节点」页切换。</Empty>
      ) : (
        <ul className="items">
          {groups.map(({ item, index }) => {
            const tag = tagsOfItem(item, index)[0];
            const members: string[] = Array.isArray(item.outbounds) ? item.outbounds : [];
            return (
              <li key={index}>
                <div className="item" role="button" tabIndex={0} onClick={() => setEditing(index)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(index)}>
                  <span className="item-main">
                    <b className="ellipsis">
                      {tag}
                      {final === tag && <span className="badge line">默认出站</span>}
                    </b>
                    <span className="ellipsis">
                      {item.type === "urltest" ? "自动选最快" : "手动选择"} · {members.length} 个成员
                      {members.length > 0 && `：${members.slice(0, 4).join("、")}${members.length > 4 ? "…" : ""}`}
                    </span>
                  </span>
                  <ItemMenu
                    actions={[
                      { label: "编辑…", icon: <Pencil size={14} />, onSelect: () => setEditing(index) },
                      { label: "复制一份", icon: <Copy size={14} />, onSelect: () => onChange(duplicateItem(config, ["outbounds"], index, "outbound")) },
                      { label: "设为默认出站", onSelect: () => onChange(setIn(config, ["route", "final"], tag)), disabled: final === tag },
                      { label: "-", onSelect: () => {} },
                      { label: "删除…", icon: <Trash2 size={14} />, onSelect: () => setDeleting(index) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing !== null && (
        <GroupDialog
          config={config}
          index={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onChange(next);
            setEditing(null);
          }}
        />
      )}
      <DeleteDialog
        config={config}
        target={deleting !== null ? { kinds: ["outbound"], tag: tagsOfItem(outbounds[deleting], deleting)[0], what: "策略组" } : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) onChange(removeItem(config, ["outbounds"], deleting));
          setDeleting(null);
        }}
      />
    </div>
  );
}

function GroupDialog({ config, index, onClose, onSave }: { config: Json; index: number | null; onClose: () => void; onSave: (next: Json) => void }) {
  const old = index === null ? null : itemsOf(config, ["outbounds"])[index];
  const [draft, setDraft] = useState<Json>(() => (old ? structuredClone(old) : { type: "selector", tag: uniqueTag(config, "outbound", "proxy"), outbounds: [] }));
  const [makeFinal, setMakeFinal] = useState(() => !old && !getIn(config, ["route", "final"]));
  const [error, setError] = useState("");
  const selfTag = old ? tagsOfItem(old, index!)[0] : undefined;
  const members: string[] = Array.isArray(draft.outbounds) ? draft.outbounds : [];
  const types = new Map<string, string>();
  [...itemsOf(config, ["outbounds"]), ...itemsOf(config, ["endpoints"])].forEach((o, i) => types.set(tagsOfItem(o, i)[0], o?.type ?? ""));
  const candidates = tagsOf(config, "outbound").filter((t) => t !== selfTag && t !== draft.tag);
  const set = (k: string, v: Json) => setDraft((d: Json) => (v === undefined ? omitKeys(d, k) : { ...d, [k]: v }));
  const setMembers = (list: string[]) => {
    setDraft((d: Json) => {
      const next = { ...d, outbounds: list };
      if (next.default && !list.includes(next.default)) delete next.default;
      return next;
    });
  };
  const move = (i: number, to: number) => {
    const list = members.slice();
    const [m] = list.splice(i, 1);
    list.splice(to, 0, m);
    setMembers(list);
  };
  const contexts = sectionContexts("outbounds", draft);
  const env = { config: index === null ? addItem(config, ["outbounds"], draft) : setIn(config, ["outbounds", index], draft), problems: new Set<string>() };

  const save = () => {
    const tag = String(draft.tag ?? "").trim();
    if (!tag) return setError("给策略组起个名字。");
    if (tag !== selfTag && uniqueTag(config, "outbound", tag) !== tag) return setError(`已有名为「${tag}」的出站。`);
    if (members.length === 0) return setError("至少选一个成员。");
    const item = { ...draft, tag };
    let next = index === null ? addItem(config, ["outbounds"], item) : replaceItem(config, ["outbounds"], index, item);
    if (makeFinal) next = setIn(next, ["route", "final"], tag);
    onSave(next);
  };

  return (
    <EditDialog open onOpenChange={(o) => !o && onClose()} title={old ? `编辑「${selfTag}」` : "新建策略组"} onSubmit={save} submit={old ? "完成" : "新建"} error={error} wide>
      <FormContext.Provider value={env}>
        <Row label="名称">
          <label className="field f-control">
            <input value={draft.tag ?? ""} onChange={(e) => set("tag", e.target.value)} spellCheck={false} />
          </label>
        </Row>
        <Row label="选择方式">
          <div className="segmented" role="group">
            <button type="button" aria-pressed={draft.type === "selector"} onClick={() => setDraft((d: Json) => ({ ...omitKeys(d, "url", "interval", "tolerance", "idle_timeout"), type: "selector" }))}>
              手动选择
            </button>
            <button type="button" aria-pressed={draft.type === "urltest"} onClick={() => setDraft((d: Json) => ({ ...omitKeys(d, "default"), type: "urltest" }))}>
              自动选最快
            </button>
          </div>
        </Row>
        <Row label="成员" hint={draft.type === "urltest" ? "定时测试这些出站的延迟，自动使用最快的。" : "可以在「节点」页或菜单栏里切换到其中一个。排在第一个的是默认选中的。"}>
          <div className="members">
            {members.map((m, i) => (
              <div className="member on" key={m}>
                <input type="checkbox" checked onChange={() => setMembers(members.filter((x) => x !== m))} aria-label={m} />
                <span className="ellipsis">{m}</span>
                <span className="faint">{types.get(m) ?? "不存在"}</span>
                <span className="end">
                  <button type="button" className="btn ghost icon" disabled={i === 0} onClick={() => move(i, i - 1)} title="上移">
                    <ArrowUp size={12} />
                  </button>
                  <button type="button" className="btn ghost icon" disabled={i === members.length - 1} onClick={() => move(i, i + 1)} title="下移">
                    <ArrowDown size={12} />
                  </button>
                </span>
              </div>
            ))}
            {candidates
              .filter((t) => !members.includes(t))
              .map((t) => (
                <label className="member" key={t}>
                  <input type="checkbox" checked={false} onChange={() => setMembers([...members, t])} />
                  <span className="ellipsis">{t}</span>
                  <span className="faint">{types.get(t)}</span>
                </label>
              ))}
            {candidates.length === 0 && <span className="faint">还没有其他出站，先去「节点」添加。</span>}
          </div>
        </Row>
        {draft.type === "selector" && members.length > 0 && (
          <Row label="默认选中" hint="启动时选中哪一个；之后切换的结果会被记住（需要开启缓存文件）。" inline>
            <select className="select" value={draft.default ?? ""} onChange={(e) => set("default", e.target.value || undefined)}>
              <option value="">第一个（{members[0]}）</option>
              {members.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Row>
        )}
        {draft.type === "urltest" && (
          <>
            <Row label="测速地址" hint="通过每个成员访问这个地址，按用时排序。">
              <label className="field f-control">
                <input list="test-urls" value={draft.url ?? ""} placeholder={testURLs[0]} onChange={(e) => set("url", e.target.value || undefined)} spellCheck={false} />
                <datalist id="test-urls">
                  {testURLs.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </label>
            </Row>
            <Row label="测速间隔" inline>
              <select className="select" value={draft.interval ?? ""} onChange={(e) => set("interval", e.target.value || undefined)}>
                <option value="">默认（3 分钟）</option>
                {intervals.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.name}
                  </option>
                ))}
                {draft.interval && !intervals.some((i) => i.value === draft.interval) && <option value={draft.interval}>{draft.interval}</option>}
              </select>
            </Row>
            <Row label="切换容差" hint="新的最快节点要比当前的快这么多毫秒才切换，避免来回跳。默认 50。" inline>
              <label className="field f-control narrow">
                <input inputMode="numeric" value={draft.tolerance ?? ""} placeholder="50" onChange={(e) => set("tolerance", digits(e.target.value))} />
                <span className="faint">ms</span>
              </label>
            </Row>
          </>
        )}
        {getIn(config, ["route", "final"]) !== (selfTag ?? draft.tag) && (
          <Row label="设为默认出站" hint="没有匹配分流规则的流量走这个组。" inline>
            <input type="checkbox" className="check" checked={makeFinal} onChange={(e) => setMakeFinal(e.target.checked)} />
          </Row>
        )}
        <More detail="空闲超时、切换时中断连接等">
          <ObjectFields node={def("Outbound")} value={draft} onChange={setDraft} contexts={contexts} path={["outbounds", index ?? 0]} hide={["tag", "outbounds", "default", "url", "interval", "tolerance"]} section="outbounds" />
        </More>
      </FormContext.Provider>
    </EditDialog>
  );
}
