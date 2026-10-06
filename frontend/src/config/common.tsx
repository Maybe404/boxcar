// The parts the wizards share: a head with the actions, rows of items, a
// dialog to edit one, and the question before one goes.
import { useState, type ReactNode } from "react";
import { AlertDialog, Dialog, DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { placeOf, refsTo, removable, type TagKind } from "./refs";
import type { Json } from "./path";

/** What a wizard edits, and the core's state, for testing nodes. */
export interface PaneProps {
  config: Json;
  onChange: (next: Json) => void;
  runtime: Runtime;
}

export interface Runtime {
  /** The core runs this configuration as saved: delays can be measured. */
  live: boolean;
  testOutbound: (tag: string) => Promise<number>;
}

export function PaneHead({ title, detail, children }: { title: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <header className="pane-head">
      <div className="what">
        <h3>{title}</h3>
        {detail && <p>{detail}</p>}
      </div>
      {children && <div className="tools">{children}</div>}
    </header>
  );
}

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ItemMenu({ actions }: { actions: MenuAction[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="btn ghost icon" aria-label="更多" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal size={15} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={4} onClick={(e) => e.stopPropagation()}>
          {actions.map((a, i) =>
            a.label === "-" ? (
              <DropdownMenu.Separator key={i} className="menu-sep" />
            ) : (
              <DropdownMenu.Item key={a.label} className={`menu-item${a.danger ? " danger" : ""}`} disabled={a.disabled} onSelect={a.onSelect}>
                {a.icon} {a.label}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A dialog to edit an item; the body scrolls, the actions stay. */
export function EditDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  submit = "完成",
  error,
  wide,
  extra,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onSubmit: () => void;
  /** null leaves the submit button out, for a step that is a choice. */
  submit?: string | null;
  error?: string;
  wide?: boolean;
  extra?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className={`dialog edit-dialog${wide ? " wide" : ""}`} onOpenAutoFocus={(e) => e.preventDefault()}>
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          {description ? (
            <Dialog.Description asChild>
              <p>{description}</p>
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          <form
            className="edit-form"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <div className="edit-body">{children}</div>
            {error && <div className="error-line selectable edit-error">{error}</div>}
            <div className="actions">
              {extra && <span className="start">{extra}</span>}
              <Dialog.Close asChild>
                <button type="button" className="btn">
                  取消
                </button>
              </Dialog.Close>
              {submit !== null && (
                <button type="submit" className="btn primary">
                  {submit}
                </button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The question before an item goes, with what still refers to it. */
export function DeleteDialog({
  config,
  target,
  onCancel,
  onConfirm,
}: {
  config: Json;
  /** What goes; kinds are those of its tag, as an endpoint is an outbound and an inbound. */
  target: { kinds: TagKind[]; tag: string; what: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const refs = target ? target.kinds.flatMap((k) => refsTo(config, k, target.tag)) : [];
  const inLists = refs.filter((r) => removable(config, r));
  const single = refs.filter((r) => !removable(config, r));
  const places = (list: typeof refs) => [...new Set(list.map((r) => placeOf(config, r.path)))];
  return (
    <AlertDialog.Root open={!!target} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog">
          <AlertDialog.Title asChild>
            <h2>
              删除{target?.what}「{target?.tag}」？
            </h2>
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="delete-refs">
              {refs.length === 0 && <p>没有其他地方引用它。</p>}
              {inLists.length > 0 && <p>会一并从这些地方移除：{places(inLists).join("、")}。</p>}
              {single.length > 0 && (
                <p className="danger-text">
                  这些地方只用到它，删除后要改成别的，否则校验不通过：{places(single).join("、")}。
                </p>
              )}
            </div>
          </AlertDialog.Description>
          <div className="actions">
            <AlertDialog.Cancel asChild>
              <button className="btn">取消</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button className="btn primary" style={{ background: "var(--danger)" }} onClick={onConfirm}>
                删除
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** A disclosure for the advanced part of a dialog. */
export function More({ title = "全部字段", detail, children, defaultOpen = false }: { title?: string; detail?: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="more">
      <button type="button" className="more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="caret-text">{open ? "▾" : "▸"}</span> {title}
        {detail && <span className="faint"> · {detail}</span>}
      </button>
      {open && <div className="more-body">{children}</div>}
    </div>
  );
}

/** A labelled control of a wizard, in the form's look. */
export function Row({ label, hint, children, inline, warn }: { label: string; hint?: ReactNode; children: ReactNode; inline?: boolean; warn?: ReactNode }) {
  return (
    <div className={`f-row${inline ? " inline" : ""}`}>
      <div className="f-main">
        <div className="f-head">
          <span className="f-label">{label}</span>
        </div>
        {hint && <div className="f-desc">{hint}</div>}
      </div>
      {children}
      {warn && <div className="f-warn">{warn}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pane-empty">
      <b>{title}</b>
      {children && <span>{children}</span>}
    </div>
  );
}

/** Choosing some of a few values, as the groups a node joins. */
export function ToggleChips({ options, value, onChange, label = (v) => v }: { options: string[]; value: string[]; onChange: (v: string[]) => void; label?: (v: string) => ReactNode }) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button type="button" key={o} className={`chip toggle${on ? " on" : ""}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((t) => t !== o) : [...value, o])}>
            {label(o)}
          </button>
        );
      })}
    </div>
  );
}

/** The digits typed, as a number; none, undefined. */
export function digits(text: string): number | undefined {
  const d = text.replace(/\D/g, "");
  return d ? Number(d) : undefined;
}
