// Two versions of a profile side by side, as the source and the profile,
// or what runs and what is saved; or one version alone, read only.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { syntaxHighlighting } from "@codemirror/language";
import { editorTheme, highlight } from "../editorTheme";
import { parseConfig, stringifyConfig } from "../config/jsonc";

/** A configuration laid out one way, so that only what it says differs; as it is when it does not parse. */
function layout(text: string): string {
  const parsed = parseConfig(text);
  return parsed.ok ? stringifyConfig(parsed.value) : text;
}

export interface Side {
  label: string;
  text: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** The older version, left; read only. */
  a: Side;
  /** The newer version, right; without it, a is shown alone. */
  b?: Side;
  /**
   * Takes back changes of b, block by block or all at once, into the text
   * given: b becomes what the editor holds, not what is saved.
   */
  onApply?: (text: string) => void;
  /** Buttons beside 关闭, as 重新载入. */
  actions?: ReactNode;
}

const base: Extension[] = [
  json(),
  editorTheme,
  syntaxHighlighting(highlight),
  EditorView.lineWrapping,
  lineNumbers(),
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorState.phrases.of({ "$ unchanged lines": "$ 行没有变化" }),
];

export function CompareDialog({ open, onOpenChange, title, description, a, b, onApply, actions }: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<MergeView | null>(null);
  const editors = useRef<EditorView[]>([]);
  const [changed, setChanged] = useState(false);
  // Laid out alike, edits of the visual editor, which writes its own
  // layout, show as what they change; comments are left out then.
  const [plain, setPlain] = useState(true);
  // Built once for each opening: the page around re-renders every second,
  // with new props each time, which must not rebuild the view.
  const props = useRef({ a, b, editable: !!onApply });
  props.current = { a, b, editable: !!onApply };

  useEffect(() => {
    if (!open) return;
    const { a: rawA, b: rawB, editable } = props.current;
    const a = plain ? { ...rawA, text: layout(rawA.text) } : rawA;
    const b = rawB && plain ? { ...rawB, text: layout(rawB.text) } : rawB;
    // The dialog's content mounts after open: wait for it.
    const frame = requestAnimationFrame(() => {
      const el = parent.current;
      if (!el) return;
      el.replaceChildren();
      setChanged(false);
      if (!b) {
        const single = new EditorView({ parent: el, state: EditorState.create({ doc: a.text, extensions: base }) });
        view.current = null;
        editors.current = [single];
        cleanup = () => single.destroy();
        return;
      }
      const mv = new MergeView({
        parent: el,
        a: { doc: a.text, extensions: base },
        // Not typed in: only the blocks taken from the left change it.
        b: { doc: b.text, extensions: [...base, EditorView.updateListener.of((u) => u.docChanged && setChanged(true))] },
        // Blocks of the left taken into the right, toward the source.
        revertControls: editable ? "a-to-b" : undefined,
        renderRevertControl: () => {
          const button = document.createElement("button");
          button.className = "cmp-revert";
          button.title = `用「${a.label}」的这一段`;
          button.textContent = "→";
          return button;
        },
        collapseUnchanged: { margin: 3, minSize: 6 },
        gutter: true,
      });
      view.current = mv;
      editors.current = [mv.a, mv.b];
      cleanup = () => mv.destroy();
    });
    let cleanup = () => {};
    return () => {
      cancelAnimationFrame(frame);
      cleanup();
      view.current = null;
    };
  }, [open, plain]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        {/* Measured again once the dialog stops scaling in. */}
        <Dialog.Content className="dialog compare" onAnimationEnd={() => editors.current.forEach((e) => e.requestMeasure())}>
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="faint" style={{ fontSize: 12 }}>
              {description}
            </div>
          </Dialog.Description>
          <div className="cmp-labels">
            <span>{a.label}</span>
            {b && <span>{b.label}</span>}
            <label className="cmp-plain" title={changed ? "已经拿回的段落还没放进编辑器，切换会丢掉它们" : undefined}>
              <input type="checkbox" checked={plain} disabled={changed} onChange={(e) => setPlain(e.target.checked)} />
              忽略格式和注释
            </label>
          </div>
          <div className={`cmp-body${b ? "" : " single"}`} ref={parent} />
          <div className="actions">
            {onApply && b && (
              <>
                {plain && <span className="faint cmp-note">放进编辑器的是重新排版的内容，注释不保留</span>}
                <button className="btn ghost" onClick={() => onApply(plain ? layout(a.text) : a.text)} title={`把「${b.label}」整份换成「${a.label}」`}>
                  整份还原为{a.label}
                </button>
                <button className="btn" disabled={!changed} onClick={() => view.current && onApply(view.current.b.state.doc.toString())}>
                  把还原的段落放进编辑器
                </button>
              </>
            )}
            {actions}
            <Dialog.Close asChild>
              <button className="btn">关闭</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
