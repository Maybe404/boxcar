import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog } from "radix-ui";
import { Command, Search } from "lucide-react";
import { Toaster, toast } from "sonner";
import { onFileDrop } from "mygo-runtime";
import { box, errorText, events, preview } from "./api";
import { duration } from "./format";
import { useGroups, useNow, useSnapshot } from "./hooks";
import { pages, type PageId } from "./pages";
import { LinePage } from "./pages/LinePage";
import { NodesPage } from "./pages/NodesPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { LogsPage } from "./pages/LogsPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { CommandBar } from "./components/CommandBar";
import { StartConfirm, startCore } from "./components/StartConfirm";

export function App() {
  const snap = useSnapshot();
  const running = snap.status === "running";
  const [groups, refreshGroups] = useGroups(running);
  const now = useNow(running);
  const [page, setPageNow] = useState<PageId>("line");
  const [command, setCommand] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [profilesVersion, setProfilesVersion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [nodeQuery, setNodeQuery] = useState("");
  // Leaving the profiles with unsaved changes asks first.
  const dirty = useRef(false);
  const [leaveTo, setLeaveTo] = useState<PageId | null>(null);
  const onDirtyChange = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const onImportHandled = useCallback(() => setImportPending(false), []);

  const setPage = useCallback((p: PageId) => {
    setPageNow((current) => {
      if (current === "profiles" && p !== "profiles" && dirty.current) {
        setLeaveTo(p);
        return current;
      }
      return p;
    });
  }, []);
  const go = useCallback(
    (p: string) => {
      if (p === "import") {
        setPage("profiles");
        setImportPending(true);
      } else if (pages.some((x) => x.id === p)) setPage(p as PageId);
    },
    [setPage],
  );

  // The menu bar's commands and keys.
  useEffect(() => events.navigate.on(go), [go]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "k") {
        e.preventDefault();
        setCommand((o) => !o);
      } else if (e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (running) box.stop().catch((err) => toast.error(errorText(err)));
        else if (snap.status === "stopped" && snap.profile) startCore();
      } else if (preview && /^[1-5]$/.test(e.key)) {
        // In the app, the menu's accelerators do this.
        setPage(pages[Number(e.key) - 1].id);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [running, snap.status, snap.profile, setPage]);

  // Configuration files dropped on the window are imported.
  useEffect(() => {
    if (preview) return;
    const enter = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && setDragging(true);
    const leave = (e: DragEvent) => !e.relatedTarget && setDragging(false);
    addEventListener("dragenter", enter);
    addEventListener("dragleave", leave);
    const off = onFileDrop(async ({ paths }) => {
      setDragging(false);
      const files = paths.filter((p) => /\.jsonc?$/i.test(p));
      if (!files.length) return toast.error("只能导入 .json 配置文件");
      try {
        const r = await box.importFiles(files);
        if (r.names.length) toast.success(r.names.length > 1 ? `已导入 ${r.names.length} 个配置` : `已导入「${r.names[0]}」`);
        if (r.failed.length) toast.error("有文件没能导入", { description: r.failed.join("\n") });
      } catch (err) {
        toast.error("导入失败", { description: errorText(err) });
      }
      setProfilesVersion((v) => v + 1);
      setPage("profiles");
    });
    return () => {
      off();
      removeEventListener("dragenter", enter);
      removeEventListener("dragleave", leave);
    };
  }, [setPage]);

  const SettingsIcon = pages[5].icon;
  const current = pages.find((p) => p.id === page)!;
  const statusText = { stopped: "未运行", starting: "正在启动", running: "运行中", stopping: "正在停止" }[snap.status];

  return (
    <>
    <div className={`app${preview ? " preview" : ""}`}>
      <aside className="sidebar">
        <nav aria-label="页面">
          {pages
            .filter((p) => p.id !== "settings")
            .map((p) => (
              <button key={p.id} className="nav-item" aria-current={page === p.id ? "page" : undefined} onClick={() => setPage(p.id)}>
                <p.icon size={15} strokeWidth={1.8} />
                {p.title}
                {p.id === "connections" && running && snap.stats.connections > 0 && <span className="count num">{snap.stats.connections}</span>}
                {p.id === "nodes" && running && groups.length > 0 && <span className="count num">{groups.length}</span>}
              </button>
            ))}
        </nav>
        <div className="sidebar-foot">
          <button className="nav-item" aria-current={page === "settings" ? "page" : undefined} onClick={() => setPage("settings")}>
            <SettingsIcon size={15} strokeWidth={1.8} />
            设置
          </button>
          <button className="nav-item" onClick={() => setCommand(true)}>
            <Command size={15} strokeWidth={1.8} />
            命令栏
            <span className="count">⌘K</span>
          </button>
          <div className="sidebar-status" role="status">
            <span className={`dot ${running ? "on" : snap.status === "stopped" ? (snap.error ? "fail" : "") : "busy"}`} />
            <span>
              {statusText}
              {running && <span className="num faint"> · {duration(now - snap.startedAt)}</span>}
            </span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="titlebar">
          <h1>{current.title}</h1>
          {preview && <span className="preview-badge">预览数据 · 不是真实状态</span>}
          <div className="tools">
            {page === "nodes" && running && <SearchField value={nodeQuery} onChange={setNodeQuery} placeholder="筛选节点" />}
          </div>
        </header>
        <div className="page" key={page}>
          {page === "line" && <LinePage snap={snap} groups={groups} refreshGroups={refreshGroups} go={go} />}
          {page === "nodes" && <NodesPage snap={snap} groups={groups} refresh={refreshGroups} query={nodeQuery} />}
          {page === "connections" && <ConnectionsPage snap={snap} />}
          {page === "logs" && <LogsPage configured={snap.logLevel} />}
          {page === "profiles" && (
            <ProfilesPage snap={snap} importPending={importPending} onImportHandled={onImportHandled} onDirtyChange={onDirtyChange} version={profilesVersion} />
          )}
          {page === "settings" && <SettingsPage snap={snap} />}
        </div>
      </main>
    </div>

      {dragging && <div className="drop-hint">松开即可导入配置文件</div>}
      <CommandBar open={command} onOpenChange={setCommand} snap={snap} groups={groups} refreshGroups={refreshGroups} go={go} />
      <StartConfirm />
      <AlertDialog.Root open={leaveTo !== null} onOpenChange={(open) => !open && setLeaveTo(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="overlay" />
          <AlertDialog.Content className="dialog">
            <AlertDialog.Title asChild>
              <h2>配置有未保存的修改</h2>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p>离开后这些修改会丢失。要留下来保存吗？</p>
            </AlertDialog.Description>
            <div className="actions">
              <button
                className="btn"
                onClick={() => {
                  dirty.current = false;
                  setPageNow(leaveTo!);
                  setLeaveTo(null);
                }}
              >
                放弃修改
              </button>
              <AlertDialog.Cancel asChild>
                <button className="btn primary">留下</button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <Toaster position="bottom-right" toastOptions={{ className: "toast" }} />
    </>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="field" style={{ width: 220 }}>
      <Search size={13} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} onKeyDown={(e) => e.key === "Escape" && onChange("")} />
    </label>
  );
}
