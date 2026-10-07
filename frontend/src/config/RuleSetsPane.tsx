// Rule sets: lists of domains and addresses that rules refer to by tag,
// downloaded, read from a file, or written inline.
import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Copy, Library, Pencil, Plus, Trash2 } from "lucide-react";
import { DeleteDialog, EditDialog, Empty, ItemMenu, More, PaneHead, Row, type PaneProps } from "./common";
import { Field, FormContext, ObjectFields } from "./SchemaForm";
import { def } from "./schema";
import { commonRuleSets, duplicateItem, ensureRuleSet, itemsOf, removeItem, replaceItem, addItem, uniqueTag } from "./ops";
import { refsTo, tagsOf, tagsOfItem } from "./refs";
import { getIn, isObject, omitKeys, setIn, type Json } from "./path";
import { thisComputer } from "../platform";

const kinds = [
  { type: "remote", name: "远程", detail: "从网址下载，定时更新" },
  { type: "local", name: "本地文件", detail: `读取${thisComputer}上的文件` },
  { type: "inline", name: "内联", detail: "规则直接写在配置里" },
];

const updateIntervals = [
  { value: "12h", name: "每 12 小时" },
  { value: "1d", name: "每天（默认）" },
  { value: "3d", name: "每 3 天" },
  { value: "7d", name: "每周" },
];

const typeOf = (set: Json) => (isObject(set) && set.type ? set.type : "inline");

export function RuleSetsPane({ config, onChange }: PaneProps) {
  const sets = itemsOf(config, ["route", "rule_set"]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const existing = new Set(tagsOf(config, "rule_set"));
  return (
    <div className="pane">
      <PaneHead title="规则集" detail="成批的域名和 IP，分流规则和 DNS 规则可以按名字引用。远程规则集在启动时下载，之后定时更新。">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="btn">
              <Library size={13} /> 常用规则集
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu templates" align="end" sideOffset={4}>
              {Object.entries(commonRuleSets).map(([tag, s]) => (
                <DropdownMenu.Item key={tag} className="menu-item two-line" disabled={existing.has(tag)} onSelect={() => onChange(ensureRuleSet(config, tag))}>
                  <b>
                    {s.name}
                    {existing.has(tag) && "（已添加）"}
                  </b>
                  <span className="muted mono">{tag}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={13} /> 添加规则集
        </button>
      </PaneHead>
      {sets.length === 0 ? (
        <Empty title="还没有规则集">从「常用规则集」添加，或者用分流规则的「国内直连」「广告拦截」模板，会自动添加需要的规则集。</Empty>
      ) : (
        <ul className="items">
          {sets.map((s, i) => {
            const tag = tagsOfItem(s, i)[0];
            const used = refsTo(config, "rule_set", tag).length;
            const type = typeOf(s);
            return (
              <li key={i}>
                <div className="item" role="button" tabIndex={0} onClick={() => setEditing(i)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(i)}>
                  <span className="item-main">
                    <b className="ellipsis">{tag}</b>
                    <span className="ellipsis">
                      {kinds.find((k) => k.type === type)?.name ?? type}
                      {type === "remote" && s.url && ` · ${s.url}`}
                      {type === "local" && s.path && ` · ${s.path}`}
                      {type === "inline" && ` · ${Array.isArray(s.rules) ? s.rules.length : 0} 条规则`}
                    </span>
                  </span>
                  <span className={`badge${used ? "" : " faint"}`}>{used ? `${used} 处使用` : "未使用"}</span>
                  <ItemMenu
                    actions={[
                      { label: "编辑…", icon: <Pencil size={14} />, onSelect: () => setEditing(i) },
                      { label: "复制一份", icon: <Copy size={14} />, onSelect: () => onChange(duplicateItem(config, ["route", "rule_set"], i, "rule_set")) },
                      { label: "-", onSelect: () => {} },
                      { label: "删除…", icon: <Trash2 size={14} />, onSelect: () => setDeleting(i) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing !== null && (
        <RuleSetDialog
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
        target={deleting !== null ? { kinds: ["rule_set"], tag: tagsOfItem(sets[deleting], deleting)[0], what: "规则集" } : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) onChange(removeItem(config, ["route", "rule_set"], deleting));
          setDeleting(null);
        }}
      />
    </div>
  );
}

/** The format a URL or path names: .srs is binary, .json source. */
function formatOf(name: string): string | undefined {
  if (/\.srs(\?|$)/i.test(name)) return "binary";
  if (/\.json[c]?(\?|$)/i.test(name)) return "source";
  return undefined;
}

function RuleSetDialog({ config, index, onClose, onSave }: { config: Json; index: number | null; onClose: () => void; onSave: (next: Json) => void }) {
  const old = index === null ? null : itemsOf(config, ["route", "rule_set"])[index];
  const [draft, setDraft] = useState<Json>(() => (old ? structuredClone(old) : { type: "remote", tag: uniqueTag(config, "rule_set", "规则集"), format: "binary", url: "" }));
  const [error, setError] = useState("");
  const selfTag = old ? tagsOfItem(old, index!)[0] : undefined;
  const type = typeOf(draft);
  const set = (k: string, v: Json) => setDraft((d: Json) => (v === undefined ? omitKeys(d, k) : { ...d, [k]: v }));
  const node = def("RuleSet");
  const env = { config: index === null ? addItem(config, ["route", "rule_set"], draft) : setIn(config, ["route", "rule_set", index], draft), problems: new Set<string>() };
  const client = draft.http_client;
  const via = isObject(client) ? (client.detour ?? "") : typeof client === "string" ? `client:${client}` : "";
  const clients = tagsOf(config, "http_client").filter(() => Array.isArray(getIn(config, ["http_clients"])));

  const switchType = (t: string) =>
    setDraft((d: Json) => {
      const base = { tag: d.tag };
      if (t === "remote") return { type: "remote", ...base, format: d.format ?? "binary", url: d.url ?? "" };
      if (t === "local") return { type: "local", ...base, format: d.format ?? "binary", path: d.path ?? "" };
      return { type: "inline", ...base, rules: Array.isArray(d.rules) ? d.rules : [{}] };
    });

  const save = () => {
    const tag = String(draft.tag ?? "").trim();
    if (!tag) return setError("给规则集起个名字，规则里用它引用。");
    if (tag !== selfTag && uniqueTag(config, "rule_set", tag) !== tag) return setError(`已有名为「${tag}」的规则集。`);
    if (type === "remote" && !String(draft.url ?? "").trim()) return setError("填写下载地址。");
    if (type === "local" && !String(draft.path ?? "").trim()) return setError("填写文件路径。");
    const item = { ...draft, tag };
    onSave(index === null ? addItem(config, ["route", "rule_set"], item) : replaceItem(config, ["route", "rule_set"], index, item));
  };

  return (
    <EditDialog open onOpenChange={(o) => !o && onClose()} title={old ? `编辑「${selfTag}」` : "添加规则集"} onSubmit={save} submit={old ? "完成" : "添加"} error={error} wide>
      <FormContext.Provider value={env}>
        <Row label="来源">
          <div className="segmented" role="group">
            {kinds.map((k) => (
              <button type="button" key={k.type} aria-pressed={type === k.type} onClick={() => type !== k.type && switchType(k.type)} title={k.detail}>
                {k.name}
              </button>
            ))}
          </div>
        </Row>
        <Row label="名称" hint="规则里用这个名字引用它。">
          <label className="field f-control">
            <input value={typeof draft.tag === "string" ? draft.tag : ""} onChange={(e) => set("tag", e.target.value)} spellCheck={false} />
          </label>
        </Row>
        {type === "remote" && (
          <>
            <Row label="下载地址">
              <label className="field f-control">
                <input
                  value={draft.url ?? ""}
                  onChange={(e) => setDraft((d: Json) => ({ ...d, url: e.target.value, ...(formatOf(e.target.value) ? { format: formatOf(e.target.value) } : {}) }))}
                  placeholder="https://…/geosite-cn.srs"
                  spellCheck={false}
                />
              </label>
            </Row>
            <Row label="更新间隔" inline>
              <select className="select" value={draft.update_interval ?? ""} onChange={(e) => set("update_interval", e.target.value || undefined)}>
                <option value="">默认（每天）</option>
                {updateIntervals
                  .filter((u) => u.value !== "1d")
                  .map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.name}
                    </option>
                  ))}
                {draft.update_interval && !updateIntervals.some((u) => u.value === draft.update_interval) && <option value={draft.update_interval}>{draft.update_interval}</option>}
              </select>
            </Row>
            <Row label="下载经过" hint="下载规则集走哪个出站。不设置时用默认 HTTP 客户端，即经过默认出站。" inline>
              <select
                className="select"
                value={via}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) set("http_client", undefined);
                  else if (v.startsWith("client:")) set("http_client", v.slice("client:".length));
                  else set("http_client", { ...(isObject(client) ? client : {}), detour: v });
                }}
              >
                <option value="">默认</option>
                {tagsOf(config, "outbound").map((t) => (
                  <option key={t} value={t}>
                    出站 {t}
                  </option>
                ))}
                {clients.map((t) => (
                  <option key={`client:${t}`} value={`client:${t}`}>
                    HTTP 客户端 {t}
                  </option>
                ))}
              </select>
            </Row>
          </>
        )}
        {type === "local" && (
          <Row label="文件路径" hint="相对路径从 App 的工作目录算起；建议填完整路径。">
            <label className="field f-control">
              <input value={draft.path ?? ""} onChange={(e) => setDraft((d: Json) => ({ ...d, path: e.target.value, ...(formatOf(e.target.value) ? { format: formatOf(e.target.value) } : {}) }))} spellCheck={false} />
            </label>
          </Row>
        )}
        {type !== "inline" && (
          <Row label="格式" inline>
            <select className="select" value={draft.format ?? ""} onChange={(e) => set("format", e.target.value || undefined)}>
              <option value="">按扩展名判断</option>
              <option value="binary">二进制（.srs）</option>
              <option value="source">源文件（.json）</option>
            </select>
          </Row>
        )}
        {type === "inline" && (
          <Field
            name="rules"
            node={(def("RuleSet").oneOf[0].properties as Json).rules}
            value={draft.rules}
            onChange={(v) => set("rules", v)}
            contexts={["rule-set", "rule-set/headless-rule"]}
            path={["route", "rule_set", index ?? 0, "rules"]}
            label="规则"
            hint="每条规则的条件写法和分流规则相同，没有动作。"
          />
        )}
        <More>
          <ObjectFields node={node} value={draft} onChange={setDraft} contexts={["rule-set"]} path={["route", "rule_set", index ?? 0]} hide={["tag", "url", "path", "format", "update_interval", "http_client", "rules"]} />
        </More>
      </FormContext.Provider>
    </EditDialog>
  );
}
