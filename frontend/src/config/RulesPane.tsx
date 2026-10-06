// Rules, routing and DNS alike: a list matched from the top, each rule a
// sentence; an editor of conditions, logical nesting and the action; and
// templates of the common ones.
import { useContext, useMemo, useState } from "react";
import { DropdownMenu, Switch } from "radix-ui";
import { ArrowDown, ArrowUp, Copy, GripVertical, LayoutTemplate, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { EditDialog, Empty, ItemMenu, More, PaneHead, Row, type PaneProps } from "./common";
import { Field, FormContext, ObjectFields, RefSelect } from "./SchemaForm";
import { objectShape, shapeOf, switchVariant, type Node } from "./schema";
import { fieldDoc, fieldLabel } from "./docs";
import { actionNode, conditionNames, conditionsNode, describeRule, isConditionKey, type RuleKind } from "./describe";
import { variantLabel } from "./labels";
import { itemsOf, routeTemplates, type Template } from "./ops";
import { getIn, isObject, moveIn, omitKeys, setIn, type Json, type Path } from "./path";

/** The conditions offered first. */
const common: Record<RuleKind, string[]> = {
  route: ["domain_suffix", "domain", "domain_keyword", "rule_set", "ip_cidr", "ip_is_private", "port", "process_name", "protocol", "network", "inbound", "clash_mode"],
  dns: ["domain_suffix", "domain", "domain_keyword", "rule_set", "query_type", "inbound", "outbound", "clash_mode"],
};

/** What each action needs, asked first. */
const actionEssentials: Record<RuleKind, Record<string, string[]>> = {
  route: { route: ["outbound"], reject: ["method"], sniff: ["sniffer"], resolve: ["server", "strategy"] },
  dns: { route: ["server"], evaluate: ["server"], reject: ["method"], predefined: ["rcode", "answer"] },
};

const docsOf = (kind: RuleKind) => (kind === "dns" ? ["dns/rule", "dns/rule_action"] : ["route/rule", "route/rule_action"]);

function emptyValue(node: Node): Json {
  const s = shapeOf(node);
  if (s.kind === "boolean") return true;
  if (s.kind === "listable" || s.kind === "array") return [];
  return "";
}

/** The keys of a rule's action, so that switching to logical keeps them. */
function actionPart(rule: Json, kind: RuleKind): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(isObject(rule) ? rule : {})) if (!isConditionKey(k, kind) && !["type", "mode", "rules", "invert"].includes(k)) out[k] = v;
  return out;
}

function conditionPart(rule: Json, kind: RuleKind): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(isObject(rule) ? rule : {})) if (isConditionKey(k, kind) || k === "invert") out[k] = v;
  return out;
}

/** The rule without conditions left empty. */
export function tidyRule(rule: Json): Json {
  if (!isObject(rule)) return rule;
  const out: Json = {};
  for (const [k, v] of Object.entries(rule)) {
    if (v === "" || (Array.isArray(v) && v.length === 0 && k !== "rules")) continue;
    out[k] = k === "rules" && Array.isArray(v) ? v.map(tidyRule) : v;
  }
  return out;
}

/** The editor of one rule; nested rules of a logical one have no action. */
export function RuleEditor({ kind, value, onChange, nested, path }: { kind: RuleKind; value: Json; onChange: (v: Json) => void; nested?: boolean; path: Path }) {
  const rule: Json = isObject(value) ? value : {};
  const logical = rule.type === "logical";
  const conditions = useMemo(() => conditionsNode(kind), [kind]);
  const props = useMemo(() => Object.fromEntries(objectShape(conditions, {}).props.filter(([k]) => k !== "invert")), [conditions]);
  const present = Object.keys(rule).filter((k) => isConditionKey(k, kind));
  const absent = Object.keys(props).filter((k) => !(k in rule));
  const firstAbsent = common[kind].filter((k) => absent.includes(k));
  const otherAbsent = absent.filter((k) => !common[kind].includes(k)).sort((a, b) => (conditionNames[a] ?? a).localeCompare(conditionNames[b] ?? b, "zh"));
  const set = (k: string, v: Json) => onChange(v === undefined ? omitKeys(rule, k) : { ...rule, [k]: v });
  const label = (k: string) => conditionNames[k] ?? fieldLabel(k, fieldDoc(docsOf(kind), k).doc);

  const toLogical = () => onChange({ type: "logical", mode: "and", rules: [conditionPart(rule, kind)], ...(nested ? {} : actionPart(rule, kind)) });
  // Back to a default rule from one sub-rule; with more, there is nothing to merge them into.
  const subs = Array.isArray(rule.rules) ? rule.rules : [];
  const toDefault = () => {
    const first = isObject(subs[0]) ? conditionPart(subs[0], kind) : {};
    const invert = !!rule.invert !== !!first.invert;
    onChange({ ...omitKeys(first, "invert"), ...(invert ? { invert: true } : {}), ...(nested ? {} : actionPart(rule, kind)) });
  };

  return (
    <div className="rule-editor">
      <Row label={nested ? "子规则类型" : "规则类型"} inline>
        <div className="segmented" role="group">
          <button type="button" aria-pressed={!logical} disabled={logical && subs.length > 1} title={logical && subs.length > 1 ? "有多条子规则，不能合成一条普通规则；先删到只剩一条" : undefined} onClick={() => logical && toDefault()}>
            普通
          </button>
          <button type="button" aria-pressed={logical} onClick={() => !logical && toLogical()}>
            逻辑组合
          </button>
        </div>
      </Row>
      {logical ? (
        <LogicalPart kind={kind} rule={rule} onChange={onChange} path={path} />
      ) : (
        <>
          <div className="conditions">
            {present.length === 0 && <p className="f-desc">没有条件时匹配{kind === "dns" ? "所有查询" : "所有流量"}。</p>}
            {present.map((k) =>
              props[k] ? (
                <Field key={k} name={k} node={props[k]} value={rule[k]} onChange={(v) => set(k, v)} contexts={docsOf(kind)} path={[...path, k]} label={label(k)} ruleKind={kind} />
              ) : null,
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="btn ghost f-add">
                  <Plus size={12} /> 添加条件
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu scroll" align="start" sideOffset={4}>
                  {firstAbsent.map((k) => (
                    <DropdownMenu.Item key={k} className="menu-item" onSelect={() => set(k, emptyValue(props[k]))}>
                      {label(k)} <span className="end muted mono">{k}</span>
                    </DropdownMenu.Item>
                  ))}
                  {otherAbsent.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
                  {otherAbsent.map((k) => (
                    <DropdownMenu.Item key={k} className="menu-item" onSelect={() => set(k, emptyValue(props[k]))}>
                      {label(k)} <span className="end muted mono">{k}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </>
      )}
      <Row label="取反" hint="条件不满足时才算匹配。" inline>
        <Switch.Root className="switch" checked={!!rule.invert} onCheckedChange={(on) => set("invert", on || undefined)} aria-label="取反">
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </Row>
      {!nested && <ActionPart kind={kind} rule={rule} onChange={onChange} path={path} />}
    </div>
  );
}

function LogicalPart({ kind, rule, onChange, path }: { kind: RuleKind; rule: Json; onChange: (v: Json) => void; path: Path }) {
  const subs: Json[] = Array.isArray(rule.rules) ? rule.rules : [];
  const [open, setOpen] = useState<number | null>(subs.length === 1 ? 0 : null);
  const setSubs = (list: Json[]) => onChange({ ...rule, rules: list });
  return (
    <>
      <Row label="组合方式" inline>
        <div className="segmented" role="group">
          {(["and", "or"] as const).map((m) => (
            <button type="button" key={m} aria-pressed={(rule.mode ?? "and") === m} onClick={() => onChange({ ...rule, mode: m })}>
              {variantLabel("mode", m)}
            </button>
          ))}
        </div>
      </Row>
      <div className="subrules">
        {subs.map((sub, i) => (
          <div className="subrule" key={i}>
            <div className="subrule-head">
              <button type="button" className="f-toggle" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                <span className="caret-text">{open === i ? "▾" : "▸"}</span>
                <span className="ellipsis">{describeRule(sub, kind).match}</span>
              </button>
              <button type="button" className="btn ghost icon" title="删除子规则" onClick={() => setSubs(subs.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            </div>
            {open === i && <RuleEditor kind={kind} value={sub} onChange={(v) => setSubs(subs.map((x, j) => (j === i ? v : x)))} nested path={[...path, "rules", i]} />}
          </div>
        ))}
        <button
          type="button"
          className="btn ghost f-add"
          onClick={() => {
            setSubs([...subs, {}]);
            setOpen(subs.length);
          }}
        >
          <Plus size={12} /> 添加子规则
        </button>
      </div>
    </>
  );
}

function ActionPart({ kind, rule, onChange, path }: { kind: RuleKind; rule: Json; onChange: (v: Json) => void; path: Path }) {
  const node = actionNode(kind);
  const shape = objectShape(node, rule);
  const disc = shape.discriminators.find((d) => d.key === "action");
  const action = String(rule.action ?? disc?.current ?? "route");
  const essentials = actionEssentials[kind][action] ?? [];
  const props = Object.fromEntries(shape.props);
  const contexts = docsOf(kind);
  const set = (k: string, v: Json) => onChange(v === undefined ? omitKeys(rule, k) : { ...rule, [k]: v });
  const conditionKeys = Object.keys(rule).filter((k) => isConditionKey(k, kind));
  const variants = disc ? disc.variants.filter((v, i, all) => all.findIndex((x) => x.value === v.value) === i) : [];
  return (
    <section className="sub">
      <h4>动作</h4>
      <Row label="匹配后" inline>
        <select
          className="select"
          value={action}
          onChange={(e) => {
            if (!disc) return;
            // Switching the action keeps the conditions; the rule's own keys stay.
            const switched = switchVariant(node, rule, disc, e.target.value);
            const kept: Json = { ...switched };
            for (const k of [...conditionKeys, "type", "mode", "rules", "invert"]) if (k in rule) kept[k] = rule[k];
            onChange(kept);
          }}
        >
          {variants.map((v) => (
            <option key={String(v.value)} value={String(v.value)}>
              {variantLabel("action", v.value, kind)}
            </option>
          ))}
        </select>
      </Row>
      {essentials.map((k) =>
        props[k] ? (
          k === "outbound" || (k === "server" && kind === "dns") || (k === "server" && action === "resolve") ? (
            <Row key={k} label={k === "outbound" ? "出站" : "DNS 服务器"}>
              <RefSelect kind={k === "outbound" ? "outbound" : "dns_server"} value={rule[k]} onChange={(v) => set(k, v)} placeholder="选择…" />
            </Row>
          ) : (
            <Field key={k} name={k} node={props[k]} value={rule[k]} onChange={(v) => set(k, v)} contexts={contexts} path={[...path, k]} ruleKind={kind} />
          )
        ) : null,
      )}
      <More title="动作的其他选项">
        <ObjectFields node={node} value={rule} onChange={onChange} contexts={contexts} path={path} hide={["action", ...essentials, ...conditionKeys, "type", "mode", "rules", "invert"]} ruleKind={kind} />
      </More>
    </section>
  );
}

/** The rules at a path: route.rules or dns.rules. */
export function RuleList({ config, onChange, path, kind, finalText }: { config: Json; onChange: (next: Json) => void; path: Path; kind: RuleKind; finalText: string }) {
  const rules = itemsOf(config, path);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const env = useContext(FormContext);
  const commit = (list: Json[]) => onChange(setIn(config, path, list.length ? list : undefined));
  return (
    <>
      {rules.length === 0 ? (
        <Empty title="还没有规则">{kind === "dns" ? "所有查询都交给默认 DNS 服务器。" : "所有流量都走默认出站。"}可以从「模板」开始。</Empty>
      ) : (
        <ol className="items rules-list">
          {rules.map((r, i) => {
            const d = describeRule(r, kind);
            const bad = [...env.problems].some((p) => p.startsWith(`${path.join(".")}[${i}]`));
            return (
              <li
                key={i}
                draggable
                onDragStart={(e) => {
                  setDrag({ from: i, over: i });
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                }}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  if (drag.over !== i) setDrag({ ...drag, over: i });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && drag.from !== drag.over) onChange(moveIn(config, path, drag.from, drag.over));
                  setDrag(null);
                }}
                onDragEnd={() => setDrag(null)}
                className={drag && drag.over === i && drag.from !== i ? (drag.from < i ? "drop-after" : "drop-before") : ""}
              >
                <div className={`item rule-row${bad ? " bad" : ""}`} role="button" tabIndex={0} onClick={() => setEditing(i)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(i)}>
                  <span className="grip" title="拖动排序">
                    <GripVertical size={13} />
                  </span>
                  <span className="index num">{i + 1}</span>
                  <span className="rule-text">
                    <span className="match">{d.match}</span>
                    <span className="arrow">→</span>
                    <b className="action">{d.action}</b>
                  </span>
                  <ItemMenu
                    actions={[
                      { label: "编辑…", icon: <Pencil size={14} />, onSelect: () => setEditing(i) },
                      { label: "上移", icon: <ArrowUp size={14} />, onSelect: () => onChange(moveIn(config, path, i, i - 1)), disabled: i === 0 },
                      { label: "下移", icon: <ArrowDown size={14} />, onSelect: () => onChange(moveIn(config, path, i, i + 1)), disabled: i === rules.length - 1 },
                      { label: "复制一份", icon: <Copy size={14} />, onSelect: () => commit([...rules.slice(0, i + 1), structuredClone(r), ...rules.slice(i + 1)]) },
                      { label: "-", onSelect: () => {} },
                      { label: "删除", icon: <Trash2 size={14} />, onSelect: () => commit(rules.filter((_, j) => j !== i)) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="rule-final">
        <span className="index">·</span>
        <span className="rule-text">
          <span className="match">{kind === "dns" ? "其余查询" : "其余流量"}</span>
          <span className="arrow">→</span>
          <b className="action">{finalText}</b>
        </span>
      </div>
      <button className="btn ghost f-add" onClick={() => setEditing("new")}>
        <Plus size={12} /> 添加规则
      </button>
      {editing !== null && (
        <RuleDialog
          kind={kind}
          initial={editing === "new" ? { action: "route" } : rules[editing]}
          path={[...path, editing === "new" ? rules.length : editing]}
          isNew={editing === "new"}
          config={config}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            commit(editing === "new" ? [...rules, rule] : rules.map((x, j) => (j === editing ? rule : x)));
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function RuleDialog({ kind, initial, path, isNew, config, onClose, onSave }: { kind: RuleKind; initial: Json; path: Path; isNew: boolean; config: Json; onClose: () => void; onSave: (rule: Json) => void }) {
  const [draft, setDraft] = useState<Json>(() => structuredClone(initial));
  const [error, setError] = useState("");
  const d = describeRule(draft, kind);
  const save = () => {
    const rule = tidyRule(draft);
    const action = rule.action ?? "route";
    if (kind === "route" && action === "route" && !rule.outbound) return setError("选择匹配后走哪个出站。");
    if (kind === "dns" && (action === "route" || action === "evaluate") && !rule.server) return setError("选择用哪个 DNS 服务器。");
    if (rule.type === "logical" && !(Array.isArray(rule.rules) && rule.rules.length)) return setError("逻辑组合至少要有一条子规则。");
    onSave(rule);
  };
  return (
    <EditDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? (kind === "dns" ? "添加 DNS 规则" : "添加分流规则") : kind === "dns" ? "编辑 DNS 规则" : "编辑分流规则"}
      description={
        <span className="rule-preview">
          {d.match} <span className="arrow">→</span> <b>{d.action}</b>
        </span>
      }
      onSubmit={save}
      submit={isNew ? "添加" : "完成"}
      error={error}
      wide
    >
      <FormContext.Provider value={{ config: setIn(config, path, draft), problems: new Set() }}>
        <RuleEditor kind={kind} value={draft} onChange={setDraft} path={path} />
      </FormContext.Provider>
    </EditDialog>
  );
}

export function TemplateMenu({ templates, config, onChange }: { templates: Template[]; config: Json; onChange: (next: Json) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="btn">
          <LayoutTemplate size={13} /> 模板
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu templates" align="end" sideOffset={4}>
          {templates.map((t) => (
            <DropdownMenu.Item
              key={t.id}
              className="menu-item two-line"
              onSelect={() => {
                const next = t.apply(config);
                if (JSON.stringify(next) === JSON.stringify(config)) toast("配置里已经有了", { description: t.name });
                else {
                  onChange(next);
                  toast.success(`已添加「${t.name}」`);
                }
              }}
            >
              <b>{t.name}</b>
              <span className="muted">{t.detail}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function RulesPane({ config, onChange }: PaneProps) {
  const final = getIn(config, ["route", "final"]);
  const first = itemsOf(config, ["outbounds"])[0]?.tag;
  return (
    <div className="pane">
      <PaneHead title="分流规则" detail="从上到下逐条匹配，第一条匹配的规则决定流量的去向；拖动可以调整顺序。">
        <TemplateMenu templates={routeTemplates} config={config} onChange={onChange} />
      </PaneHead>
      <RuleList config={config} onChange={onChange} path={["route", "rules"]} kind="route" finalText={`走 ${final || first || "direct"}（默认出站）`} />
    </div>
  );
}
