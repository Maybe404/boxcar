import { useEffect, useState } from "react";
import { AlertDialog, Dialog, Switch, ToggleGroup } from "radix-ui";
import { toast } from "sonner";
import { box, errorText, type About, type RuleInfo, type Snapshot, type Theme } from "../api";
import { DNSQuery } from "../components/DNSQuery";
import { fileManager, isWindows, mod, osName, shift, trayPlace } from "../platform";

export function SettingsPage({ snap }: { snap: Snapshot }) {
  const running = snap.status === "running";
  const [theme, setTheme] = useState<Theme>("system");
  const [about, setAbout] = useState<About | null>(null);
  const [login, setLogin] = useState(false);
  const [askProxy, setAskProxy] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleInfo[] | null>(null);
  useEffect(() => {
    box.theme().then(setTheme);
    box.about().then(setAbout);
    box.loginItem().then(setLogin);
  }, []);

  const setProxy = async (on: boolean) => {
    if (on) {
      // Say what it replaces, which it puts back once off or stopped.
      setAskProxy(await box.currentSystemProxy());
      return;
    }
    try {
      await box.setSystemProxy(false);
    } catch (err) {
      toast.error("恢复系统代理失败", { description: errorText(err) });
    }
  };

  return (
    <div className="settings">
      <section>
        <h3 className="section-title">网络</h3>
        <div className="setting">
          <div className="what">
            设为系统代理
            <span>
              {snap.systemProxy.active
                ? `系统代理正指向内核（${snap.systemProxy.address}）。关闭或停止时恢复成原来的设置。`
                : `内核运行时，把 ${osName} 系统代理指向它的 mixed / http 入站；关闭或停止时恢复原来的设置${isWindows ? "" : "（例如 Surge 的）"}。`}
            </span>
          </div>
          <Switch.Root className="switch control" checked={snap.systemProxy.enabled} onCheckedChange={setProxy} aria-label="设为系统代理">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
        </div>
        {snap.systemProxy.error && <p className="danger-text selectable" style={{ fontSize: 12, margin: "8px 0 0" }}>{snap.systemProxy.error}</p>}
      </section>

      <section>
        <h3 className="section-title">外观与启动</h3>
        <div className="setting">
          <div className="what">
            主题
            <span>跟随系统时，随 {osName} 的浅色和深色外观切换。</span>
          </div>
          <ToggleGroup.Root
            className="segmented control"
            type="single"
            value={theme}
            onValueChange={(v) => {
              if (!v) return;
              setTheme(v as Theme);
              box.setTheme(v as Theme);
            }}
            aria-label="主题"
          >
            <ToggleGroup.Item value="system">跟随系统</ToggleGroup.Item>
            <ToggleGroup.Item value="light">浅色</ToggleGroup.Item>
            <ToggleGroup.Item value="dark">深色</ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
        <div className="setting">
          <div className="what">
            登录时打开 Boxcar
            <span>只打开 App 和{trayPlace}图标，不会自动启动内核。</span>
          </div>
          <Switch.Root
            className="switch control"
            checked={login}
            onCheckedChange={async (on) => {
              try {
                await box.setLoginItem(on);
                setLogin(on);
              } catch (err) {
                toast.error("设置失败", { description: errorText(err) });
              }
            }}
            aria-label="登录时打开"
          >
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
        </div>
      </section>

      <section>
        <h3 className="section-title">诊断</h3>
        <div className="setting">
          <div className="what">
            路由规则
            <span>正在运行的配置里的规则，按匹配顺序排列。</span>
          </div>
          <button className="btn control" disabled={!running} onClick={async () => setRules(await box.rules())}>
            查看
          </button>
        </div>
        <DNSQuery running={running} />
        <div className="setting">
          <div className="what">
            清空 DNS 缓存
            <span>之后的查询会重新向 DNS 服务器请求。</span>
          </div>
          <button
            className="btn control"
            disabled={!running}
            onClick={async () => {
              await box.clearDNSCache();
              toast.success("已清空 DNS 缓存");
            }}
          >
            清空
          </button>
        </div>
        <div className="setting">
          <div className="what">
            重置 FakeIP
            <span>忘记已分配的虚假 IP，之后同一个域名会分到新的地址。需要配置里有 FakeIP DNS 服务器。</span>
          </div>
          <button
            className="btn control"
            disabled={!running}
            onClick={async () => {
              try {
                await box.resetFakeIP();
                toast.success("已重置 FakeIP");
              } catch (err) {
                toast.error(errorText(err));
              }
            }}
          >
            重置
          </button>
        </div>
      </section>

      <section>
        <h3 className="section-title">数据</h3>
        <div className="setting">
          <div className="what">
            数据目录
            <span className="selectable">{about?.dataDir}</span>
          </div>
          <button className="btn control" onClick={() => box.openDataDir()}>
            在{fileManager}中打开
          </button>
        </div>
        <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
          配置文件在 profiles 目录；内核的缓存文件等相对路径写在 work 目录。
        </p>
      </section>

      <section>
        <h3 className="section-title">关于</h3>
        <Row label="Boxcar" value={about?.app} />
        <Row label="内核" value={about ? `sing-box ${about.version}（GPL-3.0）` : undefined} />
        <Row label="运行方式" value="内核内置在 App 中，无需另行安装" />
        <Row label="Go" value={about?.go} />
        <Row label="平台" value={about?.platform} />
        <Row label="界面" value={about ? `MyGo ${about.mygo} · React` : undefined} />
        <Row label="包含的协议" value={about?.tags.join("、")} />
      </section>

      <section>
        <h3 className="section-title">快捷键</h3>
        <Row label="命令栏：切换节点、模式、页面和配置" value={`${mod}K`} />
        <Row label="启动或停止" value={`${mod}${shift}S`} />
        <Row label="页面" value={`${mod}1 – ${mod}5`} />
        <Row label="导入配置" value={`${mod}O`} />
      </section>

      <AlertDialog.Root open={askProxy !== null} onOpenChange={(open) => !open && setAskProxy(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="overlay" />
          <AlertDialog.Content className="dialog">
            <AlertDialog.Title asChild>
              <h2>把系统代理指向内核？</h2>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p>
                系统代理现在{askProxy && askProxy !== "未设置" ? `指向 ${askProxy}${isWindows ? "" : "（可能是 Surge）"}` : "未设置"}。内核运行时，{isWindows ? "浏览器" : "Safari"} 等走系统代理的应用会改走内核，不再经过{isWindows ? "原来的代理" : " Surge "}的分流；关闭这个开关或停止内核时，会恢复成现在的设置。
              </p>
            </AlertDialog.Description>
            <div className="actions">
              <AlertDialog.Cancel asChild>
                <button className="btn">取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      await box.setSystemProxy(true);
                    } catch (err) {
                      toast.error("设置系统代理失败", { description: errorText(err) });
                    }
                  }}
                >
                  {running ? "立即设置" : "启动时设置"}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root open={rules !== null} onOpenChange={(open) => !open && setRules(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="dialog" style={{ width: "min(640px, calc(100vw - 48px))", top: "10%" }}>
            <Dialog.Title asChild>
              <h2>路由规则</h2>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p>{rules?.length ? `共 ${rules.length} 条，没有匹配的流量走 final 出站。` : "配置里没有规则，所有流量走 final 出站。"}</p>
            </Dialog.Description>
            <ol className="rules selectable">
              {rules?.map((r) => (
                <li key={r.index}>
                  <span className="faint num">{r.index + 1}</span>
                  <span className="rule">{r.rule}</span>
                  <span className="action">{r.action}</span>
                </li>
              ))}
            </ol>
            <div className="actions">
              <Dialog.Close asChild>
                <button className="btn">关闭</button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="setting">
      <div className="what">{label}</div>
      <span className="control muted selectable" style={{ maxWidth: "60%", textAlign: "right" }}>
        {value ?? "—"}
      </span>
    </div>
  );
}
