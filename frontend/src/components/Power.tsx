// Starting and stopping the core, the only way it ever starts, and the
// profile it runs.
import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { box, errorText, type Profiles, type Status } from "../api";
import { startCore } from "./StartConfirm";

export function PowerButton({ status, disabled }: { status: Status; disabled?: boolean }) {
  const [pending, setPending] = useState(false);
  const busy = pending || status === "starting" || status === "stopping";
  const running = status === "running";
  const click = async () => {
    setPending(true);
    try {
      if (running) await box.stop();
      else await startCore();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <button className={`btn large ${running ? "" : "primary"}`} disabled={busy || (!running && disabled)} onClick={click}>
      {running ? <Square size={12} fill="currentColor" strokeWidth={0} /> : <Play size={13} fill="currentColor" strokeWidth={0} />}
      {status === "starting" ? "正在启动…" : status === "stopping" ? "正在停止…" : running ? "停止" : "启动"}
    </button>
  );
}

export function ProfileSwitch({ active, running }: { active: string; running: boolean }) {
  const [list, setList] = useState<Profiles | null>(null);
  const choose = async (name: string) => {
    if (name === active) return;
    try {
      await box.setActive(name);
      // A switch while running takes effect at once.
      if (running) {
        await box.reload();
        toast.success(`已切换到「${name}」并重新加载`);
      }
    } catch (err) {
      toast.error("切换配置失败", { description: errorText(err) });
    }
  };
  return (
    <DropdownMenu.Root onOpenChange={(open) => open && box.profiles().then(setList)}>
      <DropdownMenu.Trigger asChild>
        <button className="btn ghost" title={running ? "切换后会立即重新加载" : "切换配置"}>
          {active || "选择配置"}
          <ChevronDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" sideOffset={4} align="start">
          <DropdownMenu.Label className="menu-label">启动时使用的配置</DropdownMenu.Label>
          {list?.items.map((p) => (
            <DropdownMenu.Item key={p.name} className="menu-item" onSelect={() => choose(p.name)}>
              <span style={{ width: 14 }}>{p.name === list.active && <Check size={13} />}</span>
              {p.name}
            </DropdownMenu.Item>
          ))}
          {list && list.items.length === 0 && <div className="placeholder" style={{ padding: "4px 9px" }}>没有配置</div>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
