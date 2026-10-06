// ⌘K: everything in one place, nodes first, as the quickest way to switch.
import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { Dialog } from "radix-ui";
import { ArrowRight, Check, FileJson, Play, RefreshCw, Square, Unplug } from "lucide-react";
import { toast } from "sonner";
import { box, errorText, modeLabel, type OutboundGroup, type Profiles, type Snapshot } from "../api";
import { pages } from "../pages";
import { startCore } from "./StartConfirm";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snap: Snapshot;
  groups: OutboundGroup[];
  refreshGroups: () => void;
  go: (page: string) => void;
}

export function CommandBar({ open, onOpenChange, snap, groups, refreshGroups, go }: Props) {
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  useEffect(() => {
    if (open) box.profiles().then(setProfiles);
  }, [open]);
  const run = (fn: () => unknown) => {
    onOpenChange(false);
    Promise.resolve(fn()).catch((err) => toast.error(errorText(err)));
  };
  const running = snap.status === "running";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" style={{ background: "transparent" }} />
        <Dialog.Content className="command" aria-describedby={undefined}>
          <Dialog.Title style={{ display: "none" }}>命令栏</Dialog.Title>
          <Command loop label="命令栏">
            <Command.Input placeholder={running ? "切换节点、页面或配置…" : "启动、切换页面或配置…"} autoFocus />
            <Command.List>
              <Command.Empty>没有匹配的命令</Command.Empty>
              {running && snap.mode.list.length > 1 && (
                <Command.Group heading="模式">
                  {snap.mode.list.map((m) => (
                    <Command.Item key={m} value={`模式 ${modeLabel(m)} ${m}`} onSelect={() => run(() => box.setMode(m))}>
                      <span style={{ width: 14, display: "inline-flex" }}>{m === snap.mode.current && <Check size={14} />}</span>
                      {modeLabel(m)}
                      <span className="end muted">{m}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {groups
                .filter((g) => g.selectable)
                .map((g) => (
                  <Command.Group key={g.tag} heading={`切换 ${g.tag}`}>
                    {g.items.map((it) => (
                      <Command.Item
                        key={it.tag}
                        value={`${g.tag} ${it.tag} ${it.type}`}
                        onSelect={() =>
                          run(async () => {
                            await box.select(g.tag, it.tag);
                            refreshGroups();
                            toast.success(`${g.tag} 已切换到 ${it.tag}`);
                          })
                        }
                      >
                        <span style={{ width: 14, display: "inline-flex" }}>{it.tag === g.selected && <Check size={14} />}</span>
                        {it.tag}
                        <span className="end muted num">{it.delay > 0 ? `${it.delay} ms` : it.type}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              <Command.Group heading="页面">
                {pages.map((p) => (
                  <Command.Item key={p.id} value={`页面 ${p.title}`} onSelect={() => run(() => go(p.id))}>
                    <ArrowRight size={14} /> {p.title}
                    <span className="end muted">{p.key}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              {profiles && (snap.status === "stopped" || running) && (
                <Command.Group heading="启动时使用的配置">
                  {profiles.items.map((p) => (
                    <Command.Item
                      key={p.name}
                      value={`配置 ${p.name}`}
                      onSelect={() =>
                        run(async () => {
                          await box.setActive(p.name);
                          if (running && p.name !== profiles.active) await box.reload();
                        })
                      }
                    >
                      <FileJson size={14} /> {p.name}
                      {p.name === profiles.active && <span className="end muted">当前</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="内核">
                {snap.status === "stopped" && snap.profile && (
                  <Command.Item onSelect={() => run(startCore)}>
                    <Play size={14} /> 启动 <span className="end muted">{snap.profile}</span>
                  </Command.Item>
                )}
                {running && (
                  <>
                    <Command.Item onSelect={() => run(() => box.reload())}>
                      <RefreshCw size={14} /> 重新加载配置
                    </Command.Item>
                    <Command.Item onSelect={() => run(() => box.closeAllConnections())}>
                      <Unplug size={14} /> 断开全部连接
                    </Command.Item>
                    <Command.Item onSelect={() => run(() => box.stop())}>
                      <Square size={13} /> 停止
                    </Command.Item>
                  </>
                )}
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
