// The configuration schema of the core the app is built with
// (tools/configschema copies it), read the way the visual editor needs:
// which branch of a oneOf a value is, what fields an object has, what kind
// of control a field takes. The choice of branch follows refs.go.
import raw from "./gen/schema.json";
import type { Json } from "./path";

export type Node = Record<string, Json>;

export const schema = raw as Node;
const defs = (schema.$defs ?? {}) as Record<string, Node>;

/** The definition a node refers to, followed to the end. */
export function resolve(node: Node | undefined): Node | undefined {
  let n = node;
  for (let i = 0; n && typeof n.$ref === "string" && i < 32; i++) n = defs[n.$ref.replace("#/$defs/", "")];
  return n;
}

/** The name of the definition a node refers to: "Duration", "Outbound". */
export function defName(node: Node | undefined): string | undefined {
  return typeof node?.$ref === "string" ? node.$ref.replace("#/$defs/", "") : undefined;
}

export function def(name: string): Node {
  return defs[name];
}

function jsonTypeIs(v: Json, t: string): boolean {
  switch (t) {
    case "object":
      return v != null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "number":
      return typeof v === "number";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "null":
      return v === null;
  }
  return false;
}

function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const branchesOf = (n: Node, key: "oneOf" | "anyOf" | "allOf"): Node[] => (Array.isArray(n[key]) ? (n[key] as Node[]) : []);

/** Whether a value fits a node, as far as choosing a branch needs. */
export function fits(v: Json, node: Node | undefined): boolean {
  const n = resolve(node);
  if (!n) return false;
  if (typeof n.type === "string" && !jsonTypeIs(v, n.type)) return false;
  if ("const" in n && !same(v, n.const)) return false;
  for (const sub of branchesOf(n, "allOf")) if (!fits(v, sub)) return false;
  for (const key of ["oneOf", "anyOf"] as const) {
    const list = branchesOf(n, key);
    if (list.length && !choose(v, list)) return false;
  }
  if (v == null || typeof v !== "object" || Array.isArray(v)) return true;
  const required = new Set<string>(n.required ?? []);
  for (const [k, p] of Object.entries((n.properties ?? {}) as Record<string, Node>)) {
    const hasConst = "const" in p;
    const enumValues = Array.isArray(p.enum) ? (p.enum as Json[]) : null;
    if (!hasConst && !enumValues) continue;
    if (!(k in v)) {
      if (required.has(k)) return false;
      continue;
    }
    if (hasConst && !same(v[k], p.const)) return false;
    if (enumValues && !enumValues.some((e) => same(e, v[k]))) return false;
  }
  return true;
}

/** The first branch a value fits. */
export function choose(v: Json, branches: Node[]): Node | undefined {
  return branches.find((b) => fits(v, b));
}

/** Whether a node describes objects. */
export function isObjectish(node: Node | undefined): boolean {
  const n = resolve(node);
  if (!n) return false;
  if (n.type === "object" || n.properties || branchesOf(n, "allOf").length) return true;
  const list = [...branchesOf(n, "oneOf"), ...branchesOf(n, "anyOf")];
  return list.length > 0 && list.every(isObjectish);
}

/** The value a branch fixes a key to: its const, or the first of its enum. */
export function branchConst(node: Node | undefined, key: string): Json {
  const n = resolve(node);
  if (!n) return undefined;
  const p = (n.properties as Record<string, Node> | undefined)?.[key];
  if (p && "const" in p) return p.const;
  if (p && Array.isArray(p.enum)) return p.enum.find((e: Json) => e !== "") ?? "";
  for (const sub of branchesOf(n, "allOf")) {
    const c = branchConst(sub, key);
    if (c !== undefined) return c;
  }
  const list = [...branchesOf(n, "oneOf"), ...branchesOf(n, "anyOf")];
  if (list.length) return branchConst(list[0], key);
  return undefined;
}

/** Whether a branch lets the key be left out: its enum allows "". */
function branchOmits(node: Node | undefined, key: string): boolean {
  const n = resolve(node);
  if (!n) return false;
  const p = (n.properties as Record<string, Node> | undefined)?.[key];
  if (p && Array.isArray(p.enum)) return p.enum.includes("");
  return branchesOf(n, "allOf").some((sub) => branchOmits(sub, key));
}

const preferredKeys = ["type", "action", "provider", "version", "mode"];

/** The key that tells the branches of a oneOf apart, as type or action. */
export function discriminatorOf(branches: Node[]): string | undefined {
  if (branches.length < 2) return undefined;
  const first = resolve(branches[0]);
  const candidates = new Set<string>(preferredKeys);
  const collectKeys = (n: Node | undefined) => {
    if (!n) return;
    Object.keys(n.properties ?? {}).forEach((k) => candidates.add(k));
    branchesOf(n, "allOf").forEach((s) => collectKeys(resolve(s)));
  };
  collectKeys(first);
  for (const key of candidates) {
    const values = branches.map((b) => branchConst(b, key));
    if (values.some((v) => v === undefined)) continue;
    if (new Set(values.map((v) => JSON.stringify(v))).size < 2) continue;
    return key;
  }
  return undefined;
}

export interface Variant {
  value: Json;
  branch: Node;
  /** Choosing it leaves the key out. */
  omit: boolean;
}

export interface Discriminator {
  key: string;
  variants: Variant[];
  current: Json;
}

export interface ObjectShape {
  /** The fields, in the schema's order. */
  props: [string, Node][];
  required: Set<string>;
  /** The keys that choose a branch: type, action. */
  discriminators: Discriminator[];
  /** For objects keyed freely, as HTTP headers: the schema of a value. */
  map?: Node;
}

/**
 * The fields of an object node for a value: the properties of the node,
 * of every allOf, and of the branch of every oneOf the value is.
 */
export function objectShape(node: Node | undefined, value: Json): ObjectShape {
  const shape: ObjectShape = { props: [], required: new Set(), discriminators: [] };
  const seen = new Set<string>();
  const skip = new Set<string>();
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const collect = (raw: Node | undefined, depth: number) => {
    const n = resolve(raw);
    if (!n || depth > 8) return;
    for (const k of n.required ?? []) shape.required.add(k);
    for (const sub of branchesOf(n, "allOf")) collect(sub, depth + 1);
    for (const key of ["oneOf", "anyOf"] as const) {
      const list = branchesOf(n, key);
      if (!list.length || !list.every(isObjectish)) continue;
      const disc = discriminatorOf(list);
      const chosen = choose(v, list) ?? (disc && disc in v ? list.find((b) => same(branchConst(b, disc), v[disc])) : undefined) ?? list[0];
      if (disc) {
        skip.add(disc);
        shape.discriminators.push({
          key: disc,
          current: disc in v ? v[disc] : branchConst(chosen, disc),
          variants: list.map((b) => ({ value: branchConst(b, disc), branch: b, omit: branchOmits(b, disc) })),
        });
      }
      collect(chosen, depth + 1);
    }
    for (const [k, p] of Object.entries((n.properties ?? {}) as Record<string, Node>)) {
      if (seen.has(k)) continue;
      seen.add(k);
      shape.props.push([k, p]);
    }
    if (n.additionalProperties && typeof n.additionalProperties === "object") shape.map = n.additionalProperties as Node;
  };
  collect(node, 0);
  shape.props = shape.props.filter(([k, p]) => !skip.has(k) && !("const" in p));
  return shape;
}

/**
 * The value of an object node after choosing another branch for one of
 * its keys: the fields the object no longer has go.
 */
export function switchVariant(node: Node, value: Json, disc: Discriminator, next: Json): Json {
  const variant = disc.variants.find((x) => same(x.value, next));
  if (!variant) return value;
  const old: Record<string, Json> = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const probe: Record<string, Json> = { ...old, [disc.key]: next };
  if (variant.omit) delete probe[disc.key];
  const shape = objectShape(node, probe);
  const keep = new Set([...shape.props.map(([k]) => k), ...shape.discriminators.map((d) => d.key), "tag"]);
  const out: Record<string, Json> = {};
  for (const [k, val] of Object.entries(old)) if (k !== disc.key && keep.has(k)) out[k] = val;
  // The key first, as written by hand.
  return variant.omit ? out : { [disc.key]: next, ...out };
}

export type Shape =
  | { kind: "boolean" }
  | { kind: "string"; ref?: string; duration?: boolean; pattern?: string }
  | { kind: "number"; integer: boolean; min?: number; max?: number }
  | { kind: "enum"; values: Json[] }
  | { kind: "const"; value: Json }
  | { kind: "object"; node: Node }
  | { kind: "array"; items: Node }
  | { kind: "listable"; item: Node }
  | { kind: "scalar"; integer: boolean; duration: boolean }
  | { kind: "choice"; options: Node[] }
  | { kind: "any" };

/** What kind of control a field takes. */
export function shapeOf(node: Node | undefined): Shape {
  const name = defName(node);
  const n = resolve(node);
  if (!n) return { kind: "any" };
  if ("const" in n) return { kind: "const", value: n.const };
  if (Array.isArray(n.enum)) return { kind: "enum", values: n.enum };
  switch (n.type) {
    case "boolean":
      return { kind: "boolean" };
    case "string":
      return { kind: "string", ref: n["x-tag-reference"], duration: name === "Duration", pattern: n.pattern };
    case "integer":
    case "number":
      return { kind: "number", integer: n.type === "integer", min: n.minimum, max: n.maximum };
    case "array":
      return { kind: "array", items: (n.items ?? {}) as Node };
  }
  if (isObjectish(n)) return { kind: "object", node: node as Node };
  const list = [...branchesOf(n, "oneOf"), ...branchesOf(n, "anyOf")];
  if (list.length === 2) {
    const [a, b] = list.map(resolve);
    // X, or a list of X.
    if (a && b && a.type !== "array" && b.type === "array") return { kind: "listable", item: list[0] };
  }
  if (list.length && list.every((b) => ["string", "integer", "number"].includes(resolve(b)?.type))) {
    return {
      kind: "scalar",
      integer: list.some((b) => ["integer", "number"].includes(resolve(b)?.type)),
      duration: list.some((b) => defName(b) === "Duration" || resolve(b)?.pattern?.includes("ms|s|m|h")),
    };
  }
  if (list.length) return { kind: "choice", options: list };
  return { kind: "any" };
}

/** Whether list items are text a list of inputs edits: strings, numbers or one of a set. */
export function isTextItems(items: Node): boolean {
  const shape = shapeOf(items);
  // A byte string is listable itself in the schema, written as one base64 string.
  if (shape.kind === "listable") return isTextItems(shape.item);
  return ["string", "number", "scalar", "enum"].includes(shape.kind);
}

/** The branch of a choice a value is. */
export function choiceIndex(options: Node[], v: Json): number {
  const i = options.findIndex((o) => fits(v, o));
  return i < 0 ? 0 : i;
}

/** The variants of the items of an array: the types an inbound can be. */
export function itemVariants(items: Node): Discriminator | undefined {
  return objectShape(items, {}).discriminators[0];
}

/** A new item of a variant, with what it requires that has a const. */
export function newVariantItem(items: Node, value?: Json): Json {
  const disc = itemVariants(items);
  if (!disc || value === undefined) return {};
  return switchVariant(items, {}, disc, value);
}
