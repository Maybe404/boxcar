// Every way of starting sing-box goes through startCore: a configuration
// that would take over the system's network asks first.
import { useEffect, useState } from "react";
import { AlertDialog } from "radix-ui";
import { toast } from "sonner";
import { box, errorText } from "../api";

type Ask = { reasons: string[]; resolve: (ok: boolean) => void };
let asker: ((ask: Ask) => void) | null = null;

/** Starts the active profile, after asking when it takes over the network. */
export async function startCore(): Promise<void> {
  try {
    const reasons = await box.takeover();
    if (reasons.length > 0) {
      const ok = await new Promise<boolean>((resolve) => (asker ? asker({ reasons, resolve }) : resolve(false)));
      if (!ok) return;
    }
    await box.start();
  } catch (err) {
    toast.error("启动失败", { description: errorText(err) });
  }
}

export function StartConfirm() {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    asker = setAsk;
    return () => {
      asker = null;
    };
  }, []);
  const answer = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return (
    <AlertDialog.Root open={!!ask} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog" style={{ width: "min(480px, calc(100vw - 48px))" }}>
          <AlertDialog.Title asChild>
            <h2>这个配置会接管系统网络</h2>
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="muted" style={{ margin: "0 0 4px" }}>
              启动后会改动 macOS 的网络设置，正在运行的 Surge 等代理的分流可能失效：
            </div>
          </AlertDialog.Description>
          <ul className="reasons">
            {ask?.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="faint" style={{ fontSize: 12, margin: "10px 0 0" }}>
            只想在本机端口上提供代理，请去掉这些设置后再启动。
          </p>
          <div className="actions">
            <AlertDialog.Cancel asChild>
              <button className="btn" autoFocus>
                取消
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button className="btn primary" style={{ background: "var(--danger)" }} onClick={() => answer(true)}>
                仍然启动
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
