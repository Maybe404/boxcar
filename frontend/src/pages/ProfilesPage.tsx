import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { AlertDialog, Dialog, DropdownMenu, Switch } from "radix-ui";
import { CircleCheck, CircleX, Cloud, Download, FileJson, FolderOpen, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { box, errorText, events, type CheckResult, type Profiles, type Remote, type Snapshot } from "../api";
import { ago, bytes } from "../format";

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--text)" },
  ".cm-content": { fontFamily: "var(--mono)", padding: "12px 0", caretColor: "var(--line)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--text-3)", border: "none", paddingLeft: "12px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--line-soft) !important" },
  ".cm-cursor": { borderLeftColor: "var(--line)", borderLeftWidth: "2px" },
  ".cm-matchingBracket": { backgroundColor: "var(--line-soft)", outline: "none" },
  ".cm-foldGutter span": { color: "var(--text-3)" },
  ".cm-scroller": { lineHeight: "1.65" },
});

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--text)", fontWeight: "600" },
  { tag: tags.string, color: "var(--text-2)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--line)" },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: "var(--text-3)" },
  { tag: tags.comment, color: "var(--text-3)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

interface Props {
  snap: Snapshot;
  importPending: boolean;
  onImportHandled: () => void;
  /** The page reports unsaved changes, for leaving it to ask first. */
  onDirtyChange: (dirty: boolean) => void;
  /** Bumped when profiles change elsewhere, as by a drop on the window. */
  version: number;
}

export function ProfilesPage({ snap, importPending, onImportHandled, onDirtyChange, version }: Props) {
  const [list, setList] = useState<Profiles>({ active: "", items: [] });
  const [chosen, setChosen] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loadedFor, setLoadedFor] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingRemote, setEditingRemote] = useState(false);
  const [updating, setUpdating] = useState(false);

  const reload = useCallback(async (choose?: string) => {
    const l = await box.profiles();
    setList(l);
    setChosen((c) => {
      const want = choose ?? c;
      return l.items.some((p) => p.name === want) ? want : l.active || l.items[0]?.name || "";
    });
  }, []);
  useEffect(() => {
    reload();
  }, [reload, version]);

  // Read the profile chosen; only the latest read counts.
  const readSeq = useRef(0);
  const read = useCallback((name: string) => {
    const n = ++readSeq.current;
    box.readProfile(name).then(
      (t) => {
        if (n !== readSeq.current) return;
        setText(t);
        setSaved(t);
        setLoadedFor(name);
        setCheck(null);
      },
      (err) => {
        if (n !== readSeq.current) return;
        setText("");
        setSaved("");
        setLoadedFor("");
        toast.error(`读取「${name}」失败`, { description: errorText(err) });
      },
    );
  }, []);
  useEffect(() => {
    if (chosen) read(chosen);
    else setLoadedFor("");
  }, [chosen, read]);

  const dirty = loadedFor === chosen && text !== saved;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // A subscription updated elsewhere is read again, unless being edited.
  useEffect(
    () =>
      events.profiles.on(() => {
        reload();
        if (chosen && !dirty) read(chosen);
      }),
    [chosen, dirty, reload, read],
  );

  const choose = (name: string) => {
    if (name === chosen) return;
    if (dirty) setLeaving(name);
    else setChosen(name);
  };

  const importFiles = useCallback(async () => {
    try {
      const r = await box.importProfiles();
      if (r.names.length) {
        toast.success(r.names.length > 1 ? `已导入 ${r.names.length} 个配置` : `已导入「${r.names[0]}」`);
      }
      if (r.failed.length) toast.error("有文件没能导入", { description: r.failed.join("\n") });
      reload(r.names[0]);
    } catch (err) {
      toast.error("导入失败", { description: errorText(err) });
    }
  }, [reload]);
  useEffect(() => {
    if (!importPending) return;
    onImportHandled();
    importFiles();
  }, [importPending, onImportHandled, importFiles]);

  const profile = list.items.find((p) => p.name === chosen);
  const active = list.active === chosen;
  const runningThis = snap.status === "running" && snap.profile === chosen && active;

  const save = useCallback(async () => {
    if (loadedFor !== chosen) return;
    try {
      await box.saveProfile(chosen, text);
      setSaved(text);
      reload();
      if (runningThis) {
        toast.success("已保存", {
          description: "正在运行的是这个配置，重新加载后生效。",
          action: { label: "重新加载", onClick: () => box.reload().catch((err) => toast.error("重新加载失败", { description: errorText(err) })) },
        });
      } else toast.success("已保存");
    } catch (err) {
      toast.error("保存失败", { description: errorText(err) });
    }
  }, [chosen, loadedFor, text, reload, runningThis]);
  // The editor's keys call the latest save without being rebuilt.
  const saveRef = useRef(save);
  saveRef.current = save;

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheck(await box.checkProfile(text));
    } catch (err) {
      setCheck({ ok: false, error: errorText(err), warnings: [] });
    } finally {
      setChecking(false);
    }
  };
  const format = async () => {
    try {
      setText(await box.formatProfile(text));
    } catch (err) {
      toast.error("无法格式化", { description: errorText(err) });
    }
  };
  const update = async () => {
    setUpdating(true);
    try {
      await box.updateProfile(chosen);
      toast.success(`「${chosen}」已更新`);
    } catch (err) {
      toast.error("更新失败", { description: errorText(err) });
    } finally {
      setUpdating(false);
      reload();
      if (!dirty) read(chosen);
    }
  };

  const extensions = useMemo(
    () => [json(), editorTheme, syntaxHighlighting(highlight), EditorView.lineWrapping, keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (saveRef.current(), true) }])],
    [],
  );

  const newProfile = async () => {
    const name = await box.newProfile();
    reload(name);
  };

  return (
    <div className="profiles">
      <aside className="profile-list">
        <div className="head">
          <span>{list.items.length} 个配置</span>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="btn ghost icon" title="新建">
                <Plus size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                <DropdownMenu.Item className="menu-item" onSelect={newProfile}>
                  <FileJson size={14} /> 新建本地配置
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => setAdding(true)}>
                  <Cloud size={14} /> 添加订阅…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button className="btn ghost icon" title="导入配置文件（也可以直接把 JSON 文件拖进窗口）" onClick={importFiles}>
            <Download size={15} />
          </button>
        </div>
        <ul role="listbox" aria-label="配置">
          {list.items.map((p) => (
            <li key={p.name}>
              <button className="profile-item" role="option" aria-selected={p.name === chosen} onClick={() => choose(p.name)}>
                <b>
                  {p.name === list.active && <span className="dot on" title="启动时使用" />}
                  <span className="ellipsis">{p.name}</span>
                  {p.remote && <Cloud size={12} className="faint" style={{ flex: "none" }} />}
                </b>
                <span>
                  {bytes(p.size)} · {p.remote?.updatedAt ? `更新于${ago(p.remote.updatedAt)}` : ago(p.modified)}
                  {p.remote?.error && <span className="danger-text"> · 更新失败</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {profile ? (
        <section className="editor-pane">
          <header className="editor-head">
            <h2>{profile.name}</h2>
            {active ? (
              <span className="using">
                <span className="dot on" />
                启动时使用
              </span>
            ) : (
              <button
                className="btn"
                onClick={async () => {
                  await box.setActive(profile.name);
                  reload();
                  if (snap.status === "running") {
                    toast.success(`已设为启动时使用`, {
                      description: "内核正在运行，重新加载后生效。",
                      action: { label: "重新加载", onClick: () => box.reload().catch((err) => toast.error("重新加载失败", { description: errorText(err) })) },
                    });
                  }
                }}
              >
                设为启动时使用
              </button>
            )}
            <div className="tools">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="btn ghost icon" aria-label="更多">
                    <MoreHorizontal size={16} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                    <DropdownMenu.Item
                      className="menu-item"
                      onSelect={() => {
                        setRenameTo(profile.name);
                        setRenaming(true);
                      }}
                    >
                      <Pencil size={14} /> 重命名…
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="menu-item" onSelect={() => box.revealProfile(profile.name)}>
                      <FolderOpen size={14} /> 在访达中显示
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="menu-sep" />
                    <DropdownMenu.Item className="menu-item" onSelect={() => setDeleting(true)}>
                      <Trash2 size={14} /> 移到废纸篓…
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </header>
          {profile.remote && (
            <div className="remote-bar">
              <Cloud size={14} className="faint" />
              <span className="ellipsis selectable" title={profile.remote.url} style={{ minWidth: 0 }}>
                {profile.remote.url}
              </span>
              <span className="faint" style={{ flex: "none" }}>
                {profile.remote.updatedAt ? `更新于${ago(profile.remote.updatedAt)}` : "未更新"}
                {profile.remote.autoUpdate ? ` · 每 ${profile.remote.interval} 分钟自动更新` : " · 不自动更新"}
              </span>
              <span className="end">
                <button className="btn ghost" onClick={() => setEditingRemote(true)}>
                  设置…
                </button>
                <button className="btn" onClick={update} disabled={updating}>
                  <RefreshCw size={13} className={updating ? "spin" : ""} />
                  {updating ? "正在更新…" : "立即更新"}
                </button>
              </span>
            </div>
          )}
          {profile.remote?.error && (
            <div className="error-line selectable" style={{ margin: "0 24px 10px" }}>
              <CircleX size={14} />
              <span>上次更新失败：{profile.remote.error}</span>
            </div>
          )}
          <div className="editor">
            <CodeMirror
              value={text}
              onChange={(t) => {
                setText(t);
                setCheck(null);
              }}
              extensions={extensions}
              basicSetup={{ highlightActiveLine: true, foldGutter: true, autocompletion: false }}
              height="100%"
              theme="none"
            />
          </div>
          <footer className="statusbar">
            {check?.ok ? (
              <span className="msg ok" title={check.warnings.map((w) => w.message).join("\n")}>
                <CircleCheck size={14} /> 校验通过：可以启动（只检查，未启动）
                {check.warnings.length > 0 && <span className="faint">· {check.warnings.length} 处已废弃写法</span>}
              </span>
            ) : check ? (
              <span className="msg bad selectable" title={check.error}>
                <CircleX size={14} /> {check.error}
              </span>
            ) : (
              <span className="msg faint">{dirty ? "有未保存的修改" : profile.remote ? "订阅 · 下次更新会覆盖本地修改" : "JSON · sing-box 配置"}</span>
            )}
            <span className="end">
              <button className="btn ghost" onClick={format} title="按内核读取的格式重新排版（注释会丢失）">
                <Wand2 size={13} /> 格式化
              </button>
              <button className="btn" onClick={runCheck} disabled={checking}>
                {checking ? "正在校验…" : "校验"}
              </button>
              {dirty && (
                <>
                  <button className="btn ghost" onClick={() => setText(saved)}>
                    还原
                  </button>
                  <button className="btn primary" onClick={save}>
                    保存 <kbd style={{ color: "inherit", opacity: 0.75 }}>⌘S</kbd>
                  </button>
                </>
              )}
            </span>
          </footer>
        </section>
      ) : (
        <div className="empty">
          <h2>还没有配置</h2>
          <p>导入你已有的 sing-box 配置文件、添加一个订阅，或新建一个只在本机监听的示例配置。</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary large" onClick={importFiles}>
              导入配置…
            </button>
            <button className="btn large" onClick={() => setAdding(true)}>
              添加订阅…
            </button>
            <button className="btn large" onClick={newProfile}>
              新建
            </button>
          </div>
        </div>
      )}

      <RemoteDialog
        open={adding}
        title="添加订阅"
        description="App 会下载这个地址的 sing-box 配置，并按间隔自动更新。下载走系统代理（如 Surge），不经过内核。"
        submit="下载并添加"
        withName
        onOpenChange={setAdding}
        onSubmit={async (r, name) => {
          const created = await box.addRemoteProfile(name, r.url, r.autoUpdate, r.interval);
          toast.success(`已添加「${created}」`);
          reload(created);
        }}
      />
      <RemoteDialog
        open={editingRemote}
        title="订阅设置"
        description="修改地址后，点「立即更新」下载新地址的配置。"
        submit="保存"
        initial={profile?.remote ?? undefined}
        onOpenChange={setEditingRemote}
        onSubmit={async (r) => {
          await box.setRemote(chosen, r);
          reload();
        }}
      />

      <Dialog.Root open={renaming} onOpenChange={setRenaming}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="dialog">
            <Dialog.Title asChild>
              <h2>重命名配置</h2>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p>文件名会一起改。</p>
            </Dialog.Description>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await box.renameProfile(chosen, renameTo);
                  setRenaming(false);
                  setLoadedFor(renameTo.trim());
                  reload(renameTo.trim());
                } catch (err) {
                  toast.error(errorText(err));
                }
              }}
            >
              <label className="field">
                <input autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value)} aria-label="新名称" />
              </label>
              <div className="actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn">
                    取消
                  </button>
                </Dialog.Close>
                <button type="submit" className="btn primary" disabled={!renameTo.trim()}>
                  重命名
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root open={deleting} onOpenChange={setDeleting}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="overlay" />
          <AlertDialog.Content className="dialog">
            <AlertDialog.Title asChild>
              <h2>把「{chosen}」移到废纸篓？</h2>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p>{active ? "它是启动时使用的配置，移走后需要另选一个。" : "可以在废纸篓里找回。"}</p>
            </AlertDialog.Description>
            <div className="actions">
              <AlertDialog.Cancel asChild>
                <button className="btn">取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className="btn primary"
                  style={{ background: "var(--danger)" }}
                  onClick={async () => {
                    try {
                      await box.deleteProfile(chosen);
                      reload();
                    } catch (err) {
                      toast.error(errorText(err));
                    }
                  }}
                >
                  移到废纸篓
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="overlay" />
          <AlertDialog.Content className="dialog">
            <AlertDialog.Title asChild>
              <h2>「{chosen}」有未保存的修改</h2>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p>切换到「{leaving}」之前，要保存这些修改吗？</p>
            </AlertDialog.Description>
            <div className="actions">
              <AlertDialog.Cancel asChild>
                <button className="btn">取消</button>
              </AlertDialog.Cancel>
              <button
                className="btn"
                onClick={() => {
                  setText(saved);
                  setChosen(leaving!);
                  setLeaving(null);
                }}
              >
                放弃修改
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  await save();
                  setChosen(leaving!);
                  setLeaving(null);
                }}
              >
                保存
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

const intervals = [15, 30, 60, 180, 360, 720, 1440];

function RemoteDialog({
  open,
  onOpenChange,
  title,
  description,
  submit,
  withName,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submit: string;
  withName?: boolean;
  initial?: Remote;
  onSubmit: (r: Remote, name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [auto, setAuto] = useState(true);
  const [every, setEvery] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setName("");
    setLink(initial?.url ?? "");
    setAuto(initial?.autoUpdate ?? true);
    setEvery(initial?.interval || 60);
    setError("");
  }, [open, initial]);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" style={{ width: "min(480px, calc(100vw - 48px))" }}>
          <Dialog.Title asChild>
            <h2>{title}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p>{description}</p>
          </Dialog.Description>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await onSubmit({ url: link.trim(), autoUpdate: auto, interval: every }, name.trim());
                onOpenChange(false);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {withName && (
              <label>
                <span>名称</span>
                <span className="field">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="订阅" />
                </span>
              </label>
            )}
            <label>
              <span>地址</span>
              <span className="field">
                <input autoFocus value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" spellCheck={false} />
              </span>
            </label>
            <div className="row-field">
              <span>自动更新</span>
              <Switch.Root className="switch" checked={auto} onCheckedChange={setAuto} aria-label="自动更新">
                <Switch.Thumb className="switch-thumb" />
              </Switch.Root>
              <select className="select" value={every} disabled={!auto} onChange={(e) => setEvery(Number(e.target.value))} aria-label="更新间隔">
                {intervals.map((m) => (
                  <option key={m} value={m}>
                    每 {m >= 60 ? `${m / 60} 小时` : `${m} 分钟`}
                  </option>
                ))}
              </select>
            </div>
            {error && <div className="error-line selectable" style={{ margin: 0 }}>{error}</div>}
            <div className="actions">
              <Dialog.Close asChild>
                <button type="button" className="btn" disabled={busy}>
                  取消
                </button>
              </Dialog.Close>
              <button type="submit" className="btn primary" disabled={busy || !link.trim()}>
                {busy ? "正在下载…" : submit}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
