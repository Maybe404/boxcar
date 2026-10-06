// Reading and changing a value deep in a configuration without changing
// the configuration given: every change returns a new one that shares what
// did not change. Keys keep their order.

export type Path = (string | number)[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export function getIn(value: Json, path: Path): Json {
  let cur = value;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k as never];
  }
  return cur;
}

/** Sets the value at a path; undefined removes the key, or the item of an array. */
export function setIn(value: Json, path: Path, next: Json): Json {
  if (path.length === 0) return next;
  const [k, ...rest] = path;
  const child = setIn(value?.[k as never], rest, next);
  if (typeof k === "number") {
    const arr = Array.isArray(value) ? value.slice() : [];
    if (child === undefined && rest.length === 0) arr.splice(k, 1);
    else arr[k] = child;
    return arr;
  }
  const obj = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  if (child === undefined && rest.length === 0) delete obj[k];
  else obj[k] = child;
  return obj;
}

export function updateIn(value: Json, path: Path, fn: (cur: Json) => Json): Json {
  return setIn(value, path, fn(getIn(value, path)));
}

/** Moves the item of an array at a path from one index to another. */
export function moveIn(value: Json, path: Path, from: number, to: number): Json {
  return updateIn(value, path, (arr: Json[] = []) => {
    const next = arr.slice();
    const [it] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
    return next;
  });
}

/** route.rules[2].rule_set[0] */
export function pathText(path: Path): string {
  return path.reduce<string>((s, k) => (typeof k === "number" ? `${s}[${k}]` : s ? `${s}.${k}` : k), "");
}

/** The path of route.rules[2].rule_set[0]. */
export function parsePath(text: string): Path {
  const out: Path = [];
  for (const m of text.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return out;
}

export const isObject = (v: Json): v is Record<string, Json> => v != null && typeof v === "object" && !Array.isArray(v);

/** The object without some keys. */
export function omitKeys(obj: Json, ...keys: string[]): Json {
  const next = { ...obj };
  for (const k of keys) delete next[k];
  return next;
}
