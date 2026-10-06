// Configurations are JSON with comments, as the core reads them. The
// visual editor works on the plain value and writes it back as JSON:
// comments do not survive an edit made there.

/** Walks the text outside strings, dropping comments and trailing commas. */
function scan(text: string): { out: string; comments: boolean } {
  let out = "";
  let comments = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      comments = true;
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      comments = true;
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ",") {
      // A comma before a closing bracket goes.
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== "]" && text[j] !== "}") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return { out, comments };
}

/** The text without comments and trailing commas; strings stay as they are. */
export const stripJSONC = (text: string) => scan(text).out;

/** Whether the text has comments, which an edit in the visual editor drops. */
export const hasComments = (text: string) => scan(text).comments;

export type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Parses a configuration: an object, comments allowed. */
export function parseConfig(text: string): Parsed {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(stripJSONC(text));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "配置的最外层必须是一个对象 { … }" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The text of a configuration, as the visual editor writes it. */
export function stringifyConfig(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
