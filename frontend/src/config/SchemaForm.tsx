// The form of every field: generated from the schema, with the core's
// documentation beside each field. It edits the value given and keeps
// what it does not know about as it is.
import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { DropdownMenu, Switch } from "radix-ui";
import { ArrowDown, ArrowUp, ChevronRight, Copy, Plus, Trash2, X } from "lucide-react";
import {
  choiceIndex,
  defName,
  isTextItems,
  itemVariants,
  newVariantItem,
  objectShape,
  resolve,
  shapeOf,
  switchVariant,
  type Discriminator,
  type Node,
  type Shape,
} from "./schema";
import { childContexts, fieldDoc, fieldLabel, groupNames, sectionContexts, type FieldDoc } from "./docs";
import { discriminatorNames, variantLabel } from "./labels";
import { refsTo, renameRefs, tagKindNames, tagsOf, tagsOfItem, type TagKind } from "./refs";
import { kindsOf, removeItem } from "./ops";
import { missingNote, useMissingTypes } from "./build";
import { DeleteDialog } from "./common";
import { isObject, pathText, type Json, type Path } from "./path";

/** The configuration being edited, for the tags a field can refer to, and where its problems are. */
export interface FormEnv {
  config: Json;
  problems: Set<string>;
  /** Changes the whole configuration, for what reaches beyond a field: removing a tag's references. */
  update?: (next: Json) => void;
}

export const FormContext = createContext<FormEnv>({ config: {}, problems: new Set() });

interface Common {
  path: Path;
  contexts: string[];
  /** Where the value is in the configuration's sections, as dns.servers, for the documents of its items. */
  section?: string;
  /** Route or DNS: how to name the actions of rules. */
  ruleKind?: "route" | "dns";
}

// ---- Objects ----

export interface ObjectFieldsProps extends Common {
  node: Node;
  value: Json;
  onChange: (v: Json) => void;
  /** Only these fields, as a wizard's advanced part does not repeat. */
  only?: string[];
  hide?: string[];
  /** Show every field at once, instead of those set and a list of the rest. */
  expanded?: boolean;
}

export function ObjectFields({ node, value, onChange, contexts, path, only, hide, expanded, section, ruleKind }: ObjectFieldsProps) {
  const obj: Record<string, Json> = isObject(value) ? value : {};
  const shape = useMemo(() => objectShape(node, obj), [node, obj]);
  const [more, setMore] = useState(!!expanded);
  const set = (k: string, v: Json) => {
    const next = { ...obj };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const known = new Set([...shape.props.map(([k]) => k), ...shape.discriminators.map((d) => d.key)]);
  const visible = (k: string) => (!only || only.includes(k)) && !hide?.includes(k);
  // A wizard's fields in its own order.
  const props = shape.props.filter(([k]) => visible(k)).sort(([a], [b]) => (only ? only.indexOf(a) - only.indexOf(b) : 0));
  const shown = props.filter(([k]) => k in obj || shape.required.has(k));
  const rest = props.filter(([k]) => !(k in obj) && !shape.required.has(k));
  const unknown = Object.keys(obj).filter((k) => !known.has(k) && visible(k) && !shape.map);
  const mapKeys = shape.map ? Object.keys(obj).filter((k) => !known.has(k)) : [];
  const kind = ruleKind ?? (section === "dns.rules" || contexts[0]?.startsWith("dns/rule") ? "dns" : "route");

  const field = ([k, p]: [string, Node]) => (
    <Field key={k} name={k} node={p} value={obj[k]} onChange={(v) => set(k, v)} contexts={contexts} path={[...path, k]} required={shape.required.has(k)} section={section ? `${section}.${k}` : undefined} ruleKind={kind} />
  );

  // The fields not set, grouped by the document that describes them.
  const groups = useMemo(() => {
    const out = new Map<string, [string, Node][]>();
    for (const entry of rest) {
      const src = fieldDoc(contexts, entry[0]).source ?? "";
      const name = groupNames[src] && src !== contexts[0] ? groupNames[src] : "";
      out.set(name, [...(out.get(name) ?? []), entry]);
    }
    return [...out.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));
  }, [rest, contexts]);

  return (
    <div className="f-object">
      {shape.discriminators
        .filter((d) => visible(d.key))
        .map((d) => (
          <VariantField key={d.key} disc={d} onChange={(v) => onChange(switchVariant(node, obj, d, v))} contexts={contexts} ruleKind={kind} />
        ))}
      {shown.map(field)}
      {unknown.map((k) => (
        <div className="f-row" key={k}>
          <div className="f-head">
            <span className="f-label">{k}</span>
            <span className="f-note">表单不认识这个字段，原样保留</span>
            <button className="f-clear" title="删除" onClick={() => set(k, undefined)}>
              <X size={12} />
            </button>
          </div>
          <RawValue value={obj[k]} onChange={(v) => set(k, v)} />
        </div>
      ))}
      {shape.map && <MapField node={shape.map} keys={mapKeys} obj={obj} onChange={onChange} contexts={contexts} path={path} />}
      {rest.length > 0 &&
        (more ? (
          groups.map(([name, entries]) => (
            <div key={name || "own"} className="f-group">
              {name && <div className="f-group-title">{name}</div>}
              {entries.map(field)}
            </div>
          ))
        ) : (
          <button className="f-more" onClick={() => setMore(true)}>
            <Plus size={12} /> 其他 {rest.length} 个可选字段
          </button>
        ))}
      {more && rest.length > 0 && !expanded && shown.length > 0 && (
        <button className="f-more" onClick={() => setMore(false)}>
          只显示已设置的字段
        </button>
      )}
    </div>
  );
}

function VariantField({ disc, onChange, contexts, ruleKind }: { disc: Discriminator; onChange: (v: Json) => void; contexts: string[]; ruleKind: "route" | "dns" }) {
  const { doc } = fieldDoc(contexts, disc.key);
  const options = disc.variants.filter((v, i, all) => all.findIndex((x) => JSON.stringify(x.value) === JSON.stringify(v.value)) === i);
  return (
    <div className="f-row">
      <div className="f-head">
        <span className="f-label">{discriminatorNames[disc.key] ?? fieldLabel(disc.key, doc)}</span>
        <code className="f-key">{disc.key}</code>
      </div>
      {doc?.text && disc.key !== "type" && <Desc text={doc.text} />}
      <select className="select f-control" value={JSON.stringify(disc.current ?? "")} onChange={(e) => onChange(JSON.parse(e.target.value))}>
        {options.map((v) => (
          <option key={JSON.stringify(v.value)} value={JSON.stringify(v.value)}>
            {variantLabel(disc.key, v.value, ruleKind)}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---- One field ----

export interface FieldProps extends Common {
  name: string;
  node: Node;
  value: Json;
  onChange: (v: Json) => void;
  required?: boolean;
  /** A label of the wizard's own, instead of the documentation's. */
  label?: string;
  hint?: string;
}

export function Field({ name, node, value, onChange, contexts, path, required, section, ruleKind, label, hint }: FieldProps) {
  const env = useContext(FormContext);
  const { doc } = fieldDoc(contexts, name);
  const shape = shapeOf(node);
  const set = value !== undefined;
  const shownLabel = label ?? fieldLabel(name, doc);
  // The description without its first sentence when that is the label.
  const text = doc?.text?.startsWith(shownLabel) ? doc.text.slice(shownLabel.length).replace(/^[。.，,：:\s]+/, "") : doc?.text;
  const bad = env.problems.has(pathText(path)) || [...env.problems].some((p) => p.startsWith(pathText(path) + "["));
  const head = (
    <div className="f-head">
      <span className="f-label">{shownLabel}</span>
      <code className="f-key">{name}</code>
      {(required || doc?.required) && <span className="f-tag">必填</span>}
      {doc?.scope && <span className="f-tag">{doc.scope}</span>}
      {doc?.deprecated && <span className="f-tag warn">{doc.deprecated}</span>}
      {set && !required && shape.kind !== "boolean" && (
        <button className="f-clear" title="清除这个字段" onClick={() => onChange(undefined)}>
          <X size={12} />
        </button>
      )}
    </div>
  );
  const desc = hint ? <p className="f-desc">{hint}</p> : text ? <Desc text={text} /> : null;

  if (shape.kind === "boolean") {
    return (
      <div className={`f-row inline${bad ? " bad" : ""}`}>
        <div className="f-main">
          {head}
          {desc}
        </div>
        <Switch.Root className="switch" checked={value === true} onCheckedChange={(on) => onChange(on ? true : undefined)} aria-label={name}>
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </div>
    );
  }
  const nested = shape.kind === "object" || (shape.kind === "array" && isObjectItems(shape.items)) || (shape.kind === "listable" && isObjectItems(shape.item));
  return (
    <div className={`f-row${bad ? " bad" : ""}${nested ? " nested" : ""}`}>
      {head}
      {desc}
      <Control name={name} shape={shape} node={node} value={value} onChange={onChange} contexts={childContexts(contexts, name, node)} path={path} section={section} ruleKind={ruleKind} doc={doc} />
    </div>
  );
}

const isObjectItems = (items: Node) => shapeOf(items).kind === "object";

interface ControlProps extends Common {
  name: string;
  shape: Shape;
  node: Node;
  value: Json;
  onChange: (v: Json) => void;
  doc?: FieldDoc;
}

/** Values to offer for a free field: the schema's examples, and those its documentation lists as available. */
function suggestionsOf(node: Node, name: string, doc?: FieldDoc): string[] {
  const out = new Set<string>();
  const n = resolve(node);
  if (Array.isArray(n?.examples)) n.examples.forEach((e: Json) => typeof e === "string" && out.add(e));
  doc?.values?.forEach((v) => out.add(v));
  // The fingerprints of uTLS are listed under utls.
  if (name === "fingerprint" && out.size === 0) fieldDoc(["shared/tls"], "utls").doc?.values?.forEach((v) => out.add(v));
  return [...out];
}

function Control({ name, shape, node, value, onChange, contexts, path, section, ruleKind, doc }: ControlProps) {
  switch (shape.kind) {
    case "boolean":
      return (
        <Switch.Root className="switch" checked={value === true} onCheckedChange={(on) => onChange(on ? true : undefined)} aria-label={name}>
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      );
    case "string":
      if (shape.ref) return <RefSelect kind={shape.ref as TagKind} value={value} onChange={onChange} />;
      return <TextInput value={value} onChange={onChange} pattern={shape.pattern} placeholder={shape.duration ? "例如 30s、5m、1h" : ""} suggestions={suggestionsOf(node, name, doc)} />;
    case "number":
      return <NumberInput value={value} onChange={onChange} integer={shape.integer} min={shape.min} max={shape.max} />;
    case "scalar":
      return <ScalarInput value={value} onChange={onChange} integer={shape.integer} placeholder={shape.duration ? "数字，或例如 30s、5m" : ""} />;
    case "enum":
      return <EnumSelect values={shape.values} value={value} onChange={onChange} />;
    case "const":
      return <span className="f-const mono">{JSON.stringify(shape.value)}</span>;
    case "listable":
      // One object or a list of them: edited as a list, written back the same.
      if (isObjectItems(shape.item)) {
        return <ObjectList items={shape.item} value={isObject(value) ? [value] : value} onChange={onChange} contexts={contexts} path={path} section={section} ruleKind={ruleKind} />;
      }
      if (!isTextItems(shape.item)) return <RawValue value={value} onChange={onChange} />;
      return <ListField item={shape.item} value={value} onChange={onChange} single suggestions={suggestionsOf(shape.item, name, doc)} />;
    case "array":
      if (isObjectItems(shape.items)) {
        return <ObjectList items={shape.items} value={value} onChange={onChange} contexts={contexts} path={path} section={section} ruleKind={ruleKind} />;
      }
      if (!isTextItems(shape.items)) return <RawValue value={value} onChange={onChange} />;
      return <ListField item={shape.items} value={value} onChange={onChange} suggestions={suggestionsOf(shape.items, name, doc)} />;
    case "object":
      return <NestedObject node={shape.node} value={value} onChange={onChange} contexts={contexts} path={path} section={section} ruleKind={ruleKind} />;
    case "choice":
      return <ChoiceField options={shape.options} name={name} value={value} onChange={onChange} contexts={contexts} path={path} section={section} ruleKind={ruleKind} />;
    default:
      void node;
      return <RawValue value={value} onChange={onChange} />;
  }
}

// ---- Controls ----

function TextInput({ value, onChange, pattern, placeholder, suggestions = [] }: { value: Json; onChange: (v: Json) => void; pattern?: string; placeholder?: string; suggestions?: string[] }) {
  const listId = useId();
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const re = useMemo(() => {
    try {
      return pattern ? new RegExp(pattern, "u") : null;
    } catch {
      return null;
    }
  }, [pattern]);
  const invalid = !!text && !!re && !re.test(text);
  return (
    <label className={`field f-control${invalid ? " invalid" : ""}`}>
      <input value={text} placeholder={placeholder || (suggestions.length ? `例如 ${suggestions[0]}` : "")} list={suggestions.length ? listId : undefined} spellCheck={false} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}

function NumberInput({ value, onChange, integer, min, max }: { value: Json; onChange: (v: Json) => void; integer: boolean; min?: number; max?: number }) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const n = Number(draft);
  const invalid = draft !== "" && (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max));
  return (
    <label className={`field f-control narrow${invalid ? " invalid" : ""}`}>
      <input
        inputMode="numeric"
        value={draft}
        onChange={(e) => {
          const t = e.target.value.trim();
          setDraft(t);
          if (t === "") onChange(undefined);
          else if (Number.isFinite(Number(t))) onChange(Number(t));
        }}
      />
    </label>
  );
}

function ScalarInput({ value, onChange, integer, placeholder }: { value: Json; onChange: (v: Json) => void; integer: boolean; placeholder?: string }) {
  return (
    <label className="field f-control">
      <input
        value={value === undefined ? "" : String(value)}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value;
          if (t === "") onChange(undefined);
          else if (integer && /^-?\d+$/.test(t.trim())) onChange(Number(t));
          else onChange(t);
        }}
      />
    </label>
  );
}

function EnumSelect({ values, value, onChange }: { values: Json[]; value: Json; onChange: (v: Json) => void }) {
  const known = values.some((v) => JSON.stringify(v) === JSON.stringify(value));
  return (
    <select
      className="select f-control"
      value={value === undefined ? "__unset" : JSON.stringify(value)}
      onChange={(e) => onChange(e.target.value === "__unset" ? undefined : JSON.parse(e.target.value))}
    >
      <option value="__unset">（不设置，用默认值）</option>
      {!known && value !== undefined && <option value={JSON.stringify(value)}>{String(value)}（不在可选值里）</option>}
      {values.map((v) => (
        <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
          {v === "" ? "（空）" : String(v)}
        </option>
      ))}
    </select>
  );
}

/** A tag of another part of the configuration, chosen from those there are. */
export function RefSelect({ kind, value, onChange, exclude, placeholder }: { kind: TagKind; value: Json; onChange: (v: Json) => void; exclude?: string[]; placeholder?: string }) {
  const { config } = useContext(FormContext);
  const tags = tagsOf(config, kind).filter((t) => !exclude?.includes(t) || t === value);
  const missing = typeof value === "string" && value !== "" && !tags.includes(value);
  return (
    <select className={`select f-control${missing ? " invalid" : ""}`} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
      <option value="">{placeholder ?? "（不设置）"}</option>
      {missing && <option value={value}>{value}（不存在）</option>}
      {tags.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/**
 * A list of values: typed in, or chosen when they are tags or one of an
 * enum. single keeps one value as a string, as the configuration may.
 */
export function ListField({ item, value, onChange, single, suggestions: offered = [] }: { item: Node; value: Json; onChange: (v: Json) => void; single?: boolean; suggestions?: string[] }) {
  const { config } = useContext(FormContext);
  const list: Json[] = Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value];
  const itemShape = shapeOf(item);
  const ref = itemShape.kind === "string" ? (itemShape.ref as TagKind | undefined) : undefined;
  const enumValues = itemShape.kind === "enum" ? itemShape.values : null;
  const numeric = itemShape.kind === "number";
  const [draft, setDraft] = useState("");
  const listId = useId();
  const commit = (next: Json[]) => {
    if (next.length === 0) onChange(undefined);
    else if (single && next.length === 1 && !Array.isArray(value)) onChange(next[0]);
    else onChange(next);
  };
  const add = (raw: string) => {
    const parts = raw
      .split(/[\n,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const values = parts.map((p) => (numeric || (itemShape.kind === "scalar" && /^\d+$/.test(p)) ? Number(p) : p));
    commit([...list, ...values.filter((v) => !list.some((x) => JSON.stringify(x) === JSON.stringify(v)))]);
    setDraft("");
  };
  if (enumValues && enumValues.length <= 14) {
    return (
      <div className="chips f-control">
        {enumValues.map((v) => {
          const on = list.some((x) => JSON.stringify(x) === JSON.stringify(v));
          return (
            <button key={JSON.stringify(v)} className={`chip toggle${on ? " on" : ""}`} aria-pressed={on} onClick={() => commit(on ? list.filter((x) => JSON.stringify(x) !== JSON.stringify(v)) : [...list, v])}>
              {String(v)}
            </button>
          );
        })}
      </div>
    );
  }
  const suggestions = ref ? tagsOf(config, ref) : enumValues ? enumValues.map(String) : offered;
  return (
    <div className="chips f-control">
      {list.map((x, i) => {
        const missing = ref && typeof x === "string" && !suggestions.includes(x);
        return (
          <span key={`${i}-${String(x)}`} className={`chip${missing ? " invalid" : ""}`} title={missing ? `${tagKindNames[ref!]}“${x}”不存在` : undefined}>
            {String(x)}
            <button aria-label={`移除 ${String(x)}`} onClick={() => commit(list.filter((_, j) => j !== i))}>
              <X size={11} />
            </button>
          </span>
        );
      })}
      <input
        className="chip-input"
        value={draft}
        list={suggestions.length ? listId : undefined}
        placeholder={list.length ? "" : ref ? `选择或输入${tagKindNames[ref]}` : "输入后回车，可用逗号分隔多个"}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value;
          // A suggestion picked from the list is added at once; one typed
          // is not, for hk might be the start of hk2.
          const picked = (e.nativeEvent as InputEvent).inputType === "insertReplacementText" || !(e.nativeEvent as InputEvent).inputType;
          if (picked && suggestions.includes(t)) add(t);
          else setDraft(t);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && list.length) commit(list.slice(0, -1));
        }}
        onBlur={() => draft && add(draft)}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !list.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
    </div>
  );
}

function NestedObject({ node, value, onChange, contexts, path, section, ruleKind }: Common & { node: Node; value: Json; onChange: (v: Json) => void }) {
  const [open, setOpen] = useState(false);
  if (value === undefined) {
    return (
      <button className="btn ghost f-add" onClick={() => (onChange({}), setOpen(true))}>
        <Plus size={12} /> 设置
      </button>
    );
  }
  const count = isObject(value) ? Object.keys(value).length : 0;
  return (
    <div className="f-nest">
      <button className="f-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="caret" />
        {open ? "收起" : count ? `已设置 ${count} 项` : "未设置任何项"}
      </button>
      {open && <ObjectFields node={node} value={value} onChange={onChange} contexts={contexts} path={path} section={section} ruleKind={ruleKind} />}
    </div>
  );
}

/** A label for a branch of a choice. */
function optionLabel(o: Node): string {
  const n = resolve(o);
  if (!n) return "其他";
  if (n["x-tag-reference"]) return "引用";
  switch (n.type) {
    case "boolean":
      return "开关";
    case "string":
      return defName(o) === "Duration" ? "时长" : "文字";
    case "integer":
    case "number":
      return "数字";
    case "array":
      return "列表";
  }
  return "详细设置";
}

function emptyOf(o: Node): Json {
  const s = shapeOf(o);
  switch (s.kind) {
    case "boolean":
      return true;
    case "array":
    case "listable":
      return [];
    case "object":
      return {};
    default:
      return undefined;
  }
}

function ChoiceField({ options, name, value, onChange, contexts, path, section, ruleKind }: Common & { options: Node[]; name: string; value: Json; onChange: (v: Json) => void }) {
  const index = choiceIndex(options, value);
  const labels = options.map(optionLabel);
  return (
    <div className="f-choice">
      {value !== undefined && (
        <div className="segmented" role="group">
          {options.map((o, i) => (
            <button key={i} aria-pressed={i === index} onClick={() => i !== index && onChange(emptyOf(o))}>
              {labels[i]}
            </button>
          ))}
        </div>
      )}
      {value === undefined ? (
        <div className="f-choice-add">
          {options.map((o, i) => (
            <button key={i} className="btn ghost f-add" onClick={() => onChange(emptyOf(o) ?? "")}>
              <Plus size={12} /> {labels[i]}
            </button>
          ))}
        </div>
      ) : (
        <Control name={name} shape={shapeOf(options[index])} node={options[index]} value={value} onChange={onChange} contexts={contexts} path={path} section={section} ruleKind={ruleKind} />
      )}
    </div>
  );
}

function MapField({ node, keys, obj, onChange, contexts, path }: { node: Node; keys: string[]; obj: Record<string, Json>; onChange: (v: Json) => void; contexts: string[]; path: Path }) {
  const [draft, setDraft] = useState("");
  const shape = shapeOf(node);
  const set = (k: string, v: Json) => {
    const next = { ...obj };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className="f-map">
      {keys.map((k) => (
        <div className="f-row" key={k}>
          <div className="f-head">
            <code className="f-key strong">{k}</code>
            <button className="f-clear" title="删除" onClick={() => set(k, undefined)}>
              <X size={12} />
            </button>
          </div>
          <Control name={k} shape={shape} node={node} value={obj[k]} onChange={(v) => set(k, v)} contexts={contexts} path={[...path, k]} />
        </div>
      ))}
      <form
        className="f-map-add"
        onSubmit={(e) => {
          e.preventDefault();
          const k = draft.trim();
          if (!k || k in obj) return;
          set(k, emptyOf(node) ?? "");
          setDraft("");
        }}
      >
        <label className="field f-control narrow">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="新的名称" spellCheck={false} />
        </label>
        <button className="btn" type="submit" disabled={!draft.trim()}>
          添加
        </button>
      </form>
    </div>
  );
}

/** A value as JSON, for what the form has no control for. */
export function RawValue({ value, onChange }: { value: Json; onChange: (v: Json) => void }) {
  const text = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState("");
  // A value changed elsewhere shows; the one typed here stays as typed.
  useEffect(() => {
    setDraft((d) => {
      try {
        return JSON.stringify(JSON.parse(d)) === JSON.stringify(value) ? d : text;
      } catch {
        return value === undefined ? d : text;
      }
    });
  }, [text, value]);
  return (
    <div className="f-raw">
      <textarea
        className="mono"
        value={draft}
        spellCheck={false}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        onChange={(e) => {
          setDraft(e.target.value);
          // Emptied, it waits for a value: the field goes with its ×.
          if (!e.target.value.trim()) return setError("");
          try {
            onChange(JSON.parse(e.target.value));
            setError("");
          } catch {
            setError("不是有效的 JSON，改好之前不会保存这个字段");
          }
        }}
      />
      {error && <span className="danger-text f-desc">{error}</span>}
    </div>
  );
}

// ---- Lists of objects ----

/** The summary of an item: its tag and type, or what it is. */
export function itemSummary(item: Json, index: number): { title: string; detail: string } {
  if (!isObject(item)) return { title: `第 ${index + 1} 项`, detail: "" };
  const tag = typeof item.tag === "string" ? item.tag : Array.isArray(item.tag) ? item.tag.join(", ") : "";
  const type = typeof item.type === "string" ? item.type : typeof item.action === "string" ? item.action : "";
  const server = typeof item.server === "string" ? `${item.server}${item.server_port ? `:${item.server_port}` : ""}` : "";
  return { title: tag || type || `第 ${index + 1} 项`, detail: [tag ? type : "", server].filter(Boolean).join(" · ") };
}

export function ObjectList({ items, value, onChange, contexts, path, section, ruleKind, summary = itemSummary }: Common & { items: Node; value: Json; onChange: (v: Json) => void; summary?: (item: Json, i: number) => { title: string; detail: string } }) {
  const list: Json[] = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState<Set<number>>(new Set());
  const disc = useMemo(() => itemVariants(items), [items]);
  const commit = (next: Json[]) => onChange(next.length ? next : undefined);
  const add = (variant?: Json) => {
    const item = disc && variant !== undefined ? newVariantItem(items, variant) : {};
    commit([...list, item]);
    setOpen(new Set(open).add(list.length));
  };
  const move = (i: number, to: number) => {
    if (to < 0 || to >= list.length) return;
    const next = list.slice();
    const [it] = next.splice(i, 1);
    next.splice(to, 0, it);
    commit(next);
    setOpen(new Set());
  };
  const variants = disc?.variants.filter((v, i, all) => all.findIndex((x) => JSON.stringify(x.value) === JSON.stringify(v.value)) === i) ?? [];
  // An item others refer to by tag goes after a question, out of their lists too.
  const env = useContext(FormContext);
  const kinds = section ? kindsOf(section.split(".")) : [];
  const [deleting, setDeleting] = useState<number | null>(null);
  const missing = useMissingTypes();
  const remove = (i: number) => {
    const tag = tagsOfItem(list[i], i)[0];
    if (env.update && kinds.some((k) => refsTo(env.config, k, tag).length)) return setDeleting(i);
    commit(list.filter((_, j) => j !== i));
    setOpen(new Set());
  };
  return (
    <div className="f-list">
      {kinds.length > 0 && (
        <DeleteDialog
          config={env.config}
          target={deleting !== null ? { kinds, tag: tagsOfItem(list[deleting], deleting)[0], what: "" } : null}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (deleting !== null && section) env.update?.(removeItem(env.config, section.split("."), deleting));
            setDeleting(null);
            setOpen(new Set());
          }}
        />
      )}
      {list.map((item, i) => {
        const s = summary(item, i);
        const isOpen = open.has(i);
        const ctx = section ? sectionContexts(section, item) : [];
        return (
          <div className="f-item" key={i}>
            <div className="f-item-head">
              <button
                className="f-toggle"
                aria-expanded={isOpen}
                onClick={() => {
                  const next = new Set(open);
                  if (isOpen) next.delete(i);
                  else next.add(i);
                  setOpen(next);
                }}
              >
                <ChevronRight size={12} className="caret" />
                <b className="ellipsis">{s.title}</b>
                {s.detail && <span className="faint ellipsis">{s.detail}</span>}
              </button>
              <span className="f-item-tools">
                <button className="btn ghost icon" title="上移" disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp size={13} />
                </button>
                <button className="btn ghost icon" title="下移" disabled={i === list.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown size={13} />
                </button>
                <button className="btn ghost icon" title="复制一份" onClick={() => {
                    commit([...list.slice(0, i + 1), copyOf(item), ...list.slice(i + 1)]);
                    // Indices after it shift, as on a move: what was open closes.
                    setOpen(new Set());
                  }}
                >
                  <Copy size={13} />
                </button>
                <button className="btn ghost icon" title="删除" onClick={() => remove(i)}>
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
            {isOpen && (
              <div className="f-item-body">
                {kinds.length > 0 && <RenameNote kinds={kinds} item={item} index={i} />}
                <ObjectFields node={items} value={item} onChange={(v) => commit(list.map((x, j) => (j === i ? v : x)))} contexts={ctx.length ? ctx : contexts} path={[...path, i]} section={section} ruleKind={ruleKind} />
              </div>
            )}
          </div>
        );
      })}
      {disc && variants.length > 1 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="btn ghost f-add">
              <Plus size={12} /> 添加…
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu scroll" align="start" sideOffset={4}>
              {variants.map((v) => {
                const left = disc.key === "type" && missing.has(`${section}/${v.value}`);
                return (
                  <DropdownMenu.Item key={JSON.stringify(v.value)} className="menu-item" disabled={left} onSelect={() => add(v.value)}>
                    {variantLabel(disc.key, v.value, ruleKind)}
                    {left && <span className="faint">（{missingNote}）</span>}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : (
        <button className="btn ghost f-add" onClick={() => add(variants[0]?.value)}>
          <Plus size={12} /> 添加
        </button>
      )}
    </div>
  );
}

/**
 * The tag of an item as it was when opened: once changed, what still refers
 * to the old one is named, to change along at a click. Not as typed, for a
 * name on its way may be another item's.
 */
function RenameNote({ kinds, item, index }: { kinds: TagKind[]; item: Json; index: number }) {
  const env = useContext(FormContext);
  const [old, setOld] = useState(() => tagsOfItem(item, index)[0]);
  const now = tagsOfItem(item, index)[0];
  const count = now === old ? 0 : kinds.reduce((n, k) => n + refsTo(env.config, k, old).length, 0);
  if (!count || !env.update) return null;
  return (
    <div className="f-row">
      <div className="f-desc open">
        原来的名字「{old}」还有 {count} 处引用。
        <button
          className="link-inline"
          onClick={() => {
            let next = env.config;
            for (const k of kinds) next = renameRefs(next, k, old, now);
            env.update!(next);
            setOld(now);
          }}
        >
          都改成「{now}」
        </button>
      </div>
    </div>
  );
}

/** A copy of an item, its tag made new. */
function copyOf(item: Json): Json {
  const copy = structuredClone(item);
  if (isObject(copy) && typeof copy.tag === "string" && copy.tag) copy.tag = `${copy.tag} 副本`;
  return copy;
}

// ---- Descriptions ----

/** The documentation of a field: two lines, the rest on a click. Lists of values read as one line. */
export function Desc({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => {
    const out: string[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length) out.push(run.join("、"));
      run = [];
    };
    for (const line of text.split("\n")) {
      const m = /^[*-] (.*)$/.exec(line);
      if (m && m[1].length <= 40) run.push(m[1]);
      else {
        flush();
        if (line || open) out.push(line);
      }
    }
    flush();
    return out;
  }, [text, open]);
  const long = text.length > 90 || lines.length > 2;
  return (
    <div className={`f-desc${open ? " open" : ""}`} onClick={() => long && setOpen(!open)} title={long && !open ? "点击展开" : undefined}>
      {lines.map((line, i) => (line ? <p key={i}>{inline(line)}</p> : <br key={i} />))}
    </div>
  );
}

function inline(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const text = line.replace(/^\* /, "· ");
  text.split(/(`[^`]+`)/).forEach((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push(<code key={i}>{part.slice(1, -1)}</code>);
    else if (part) out.push(part.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/==([^=]+)==/g, "$1"));
  });
  return out;
}
