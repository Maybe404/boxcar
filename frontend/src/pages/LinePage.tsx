import { useState } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import { toast } from "sonner";
import { box, errorText, modeLabel, type Connection, type OutboundGroup, type Snapshot } from "../api";
import { ago, bytes, duration, rate } from "../format";
import { useNow, usePoll } from "../hooks";
import { TransitLine } from "../components/TransitLine";
import { Route } from "../components/Route";
import { PowerButton, ProfileSwitch } from "../components/Power";

interface Props {
  snap: Snapshot;
  groups: OutboundGroup[];
  refreshGroups: () => void;
  go: (page: string) => void;
}

export function LinePage({ snap, groups, refreshGroups, go }: Props) {
  const running = snap.status === "running";
  const now = useNow(running);
  const [conns] = usePoll<Connection[]>(() => box.connections(false), 2000, running, []);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const s = snap.stats;
  const node = snap.line.find((x) => x.kind === "node")?.title;

  const title = {
    stopped: "未运行",
    starting: "正在启动",
    running: "正在运行",
    stopping: "正在停止",
  }[snap.status];

  let sub: React.ReactNode;
  if (running) {
    sub = (
      <>
        配置「{snap.profile}」{node && <> · 经由 {node}</>} · 已运行 <span className="num">{duration(now - snap.startedAt)}</span>
      </>
    );
  } else if (snap.profile) {
    sub = <>将使用配置「{snap.profile}」。点击启动之前，不会改动任何网络设置。</>;
  } else {
    sub = (
      <>
        还没有配置。
        <button className="link-inline" onClick={() => go("profiles")}>
          去导入一个
        </button>
      </>
    );
  }

  const setMode = async (mode: string) => {
    if (!mode || mode === snap.mode.current) return;
    try {
      await box.setMode(mode);
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <div className="line-page">
      <TransitLine snap={snap} groups={groups} onGroupsChanged={refreshGroups} />

      <div className="state">
        <h2>
          <span className={`dot ${running ? "on" : snap.status === "stopped" ? (snap.error ? "fail" : "") : "busy"}`} />
          {title}
        </h2>
        <p className="sub">{sub}</p>
        <div className="row">
          <PowerButton status={snap.status} disabled={!snap.profile} />
          {(snap.status === "stopped" || running) && <ProfileSwitch active={snap.profile} running={running} />}
          {running && snap.mode.list.length > 1 && (
            <ToggleGroup.Root className="segmented" type="single" value={snap.mode.current} onValueChange={setMode} aria-label="模式" style={{ marginLeft: "auto" }}>
              {snap.mode.list.map((m) => (
                <ToggleGroup.Item key={m} value={m} title={m}>
                  {modeLabel(m)}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          )}
        </div>
        {snap.error && snap.status === "stopped" && (
          <div className="error-line selectable">
            <AlertCircle size={14} />
            <span>{snap.error}</span>
          </div>
        )}
        {running && snap.systemProxy.error && (
          <div className="error-line selectable">
            <AlertCircle size={14} />
            <span>系统代理：{snap.systemProxy.error}</span>
          </div>
        )}
        {snap.warnings.length > 0 && (
          <div className="note-line">
            <AlertTriangle size={14} />
            <span>
              配置里有 {snap.warnings.length} 处写法已被内核废弃，
              <button className="link-inline" onClick={() => setWarningsOpen((o) => !o)}>
                {warningsOpen ? "收起" : "查看"}
              </button>
              {warningsOpen && (
                <ul className="warnings selectable">
                  {snap.warnings.map((w) => (
                    <li key={w.message}>
                      {w.impending && <b>即将移除：</b>}
                      {w.message}
                      {w.link && <span className="faint"> · {w.link}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="columns">
        <section>
          <h3>运行数据</h3>
          <dl className="figures">
            <Figure lead label="下载" value={running ? rate(s.downloadRate) : "—"} />
            <Figure lead label="上传" value={running ? rate(s.uploadRate) : "—"} />
            <Figure label="已下载" value={running ? bytes(s.download) : "—"} />
            <Figure label="已上传" value={running ? bytes(s.upload) : "—"} />
            <Figure label="活动连接" value={running ? String(s.connections) : "—"} />
            <Figure label="出站连接" value={running ? String(s.outboundConnections) : "—"} />
            <Figure label="内存" value={running && s.memory ? bytes(s.memory) : "—"} />
            <Figure label="系统代理" value={snap.systemProxy.active ? snap.systemProxy.address ?? "已设置" : snap.systemProxy.enabled ? "启动后设置" : "未设置"} />
          </dl>
        </section>
        <section>
          <h3>
            最近连接
            {running && (
              <button className="link" onClick={() => go("connections")}>
                全部 {s.connections} 个
              </button>
            )}
          </h3>
          {running && conns.length > 0 ? (
            <ul className="recent">
              {conns.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <span className="host">{c.domain || c.destination}</span>
                  <span className="when">{ago(c.createdAt, now)}</span>
                  <Route chain={c.chain} inbound={c.inbound} outbound={c.outbound} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="placeholder">{running ? "还没有连接。把应用的代理设为入站地址后，连接会出现在这里。" : "启动后显示经过内核的连接。"}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Figure({ label, value, lead }: { label: string; value: string; lead?: boolean }) {
  return (
    <div className={`figure${lead ? " lead" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
