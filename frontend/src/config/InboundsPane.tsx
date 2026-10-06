// Local proxy ports: the inbounds other programs send traffic through.
// A port listens on this Mac only unless asked; what would take over the
// system's network is apart, under 高级, with what it does.
import { useState } from "react";
import { AlertDialog, Switch } from "radix-ui";
import { Copy, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { DeleteDialog, digits, EditDialog, Empty, ItemMenu, More, PaneHead, Row, type PaneProps } from "./common";
import { FormContext, ObjectFields } from "./SchemaForm";
import { def, objectShape, type Node } from "./schema";
import { sectionContexts } from "./docs";
import { addItem, duplicateItem, itemsOf, removeItem, replaceItem, uniqueTag } from "./ops";
import { tagsOfItem } from "./refs";
import { getIn, isObject, omitKeys, setIn, type Json } from "./path";

/** Ports other proxy apps use by default. */
const knownPorts: Record<number, string> = {
  6152: "常见代理工具（如 Surge）的默认 HTTP 端口",
  6153: "常见代理工具（如 Surge）的默认 SOCKS5 端口",
  6170: "常见代理工具（如 Surge）的默认端口",
  6171: "常见代理工具（如 Surge）的默认端口",
  7890: "Clash 系列的默认端口",
  7891: "Clash 系列的默认端口",
  9090: "Clash API 的默认端口",
};

const portTypes = [
  { type: "mixed", name: "HTTP + SOCKS5", detail: "推荐：两种协议都能用" },
  { type: "http", name: "HTTP", detail: "" },
  { type: "socks", name: "SOCKS5", detail: "" },
];

const listens = [
  { value: "127.0.0.1", name: "仅本机（127.0.0.1）" },
  { value: "::1", name: "仅本机，IPv6（::1）" },
  { value: "0.0.0.0", name: "局域网（0.0.0.0）" },
  { value: "::", name: "局域网，IPv4 和 IPv6（::）" },
];

const isPublic = (listen: Json) => listen === "0.0.0.0" || listen === "::" || listen === "" || listen === undefined;

/** What an inbound would change in the system's network, if anything. */
export function takeoverOf(inbound: Json): string | null {
  if (!isObject(inbound)) return null;
  if (inbound.type === "tun") return "创建虚拟网卡并接管系统路由";
  if (inbound.type === "redirect" || inbound.type === "tproxy") return "透明代理，需要改系统路由";
  if (inbound.set_system_proxy) return "启动时改写 macOS 系统代理";
  return null;
}

export function InboundsPane({ config, onChange }: PaneProps) {
  const inbounds = itemsOf(config, ["inbounds"]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [askTun, setAskTun] = useState(false);
  const hasTun = inbounds.some((i) => i?.type === "tun");

  return (
    <div className="pane">
      <PaneHead title="本地代理端口" detail="其他程序把流量交给内核的入口。只监听本机时，只有设置了这个端口的程序会经过内核，其他软件不受影响。">
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={13} /> 添加端口
        </button>
      </PaneHead>
      {inbounds.length === 0 ? (
        <Empty title="还没有入站">没有入站时，内核收不到任何流量。点「添加端口」开一个只在本机监听的端口。</Empty>
      ) : (
        <ul className="items">
          {inbounds.map((it, i) => {
            const tag = tagsOfItem(it, i)[0];
            const port = it?.listen_port ? `${it.listen ?? "::"}:${it.listen_port}` : "";
            const takeover = takeoverOf(it);
            return (
              <li key={i}>
                <div className="item" role="button" tabIndex={0} onClick={() => setEditing(i)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(i)}>
                  <span className="item-main">
                    <b className="ellipsis">{tag}</b>
                    <span className="ellipsis">
                      {it?.type}
                      {port && ` · ${port}`}
                    </span>
                  </span>
                  {takeover ? (
                    <span className="badge danger" title={takeover}>
                      接管系统网络
                    </span>
                  ) : it?.listen_port && isPublic(it.listen) ? (
                    <span className="badge" title="局域网内的设备也能连接">
                      局域网可连
                    </span>
                  ) : null}
                  <ItemMenu
                    actions={[
                      { label: "编辑…", icon: <Pencil size={14} />, onSelect: () => setEditing(i) },
                      { label: "复制一份", icon: <Copy size={14} />, onSelect: () => onChange(duplicateInbound(config, i)) },
                      { label: "-", onSelect: () => {} },
                      { label: "删除…", icon: <Trash2 size={14} />, onSelect: () => setDeleting(i) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <More title="高级：会接管系统网络的入站" detail="TUN、透明代理">
        <div className="caution">
          <TriangleAlert size={14} />
          <div>
            <p>TUN 入站在启动时创建虚拟网卡并改写系统路由，所有程序的流量都会经过内核。它会和 Surge 等同样接管网络的工具冲突，停止前其他代理工具可能无法正常工作。</p>
            <p>只想让个别程序走内核时，用上面的本地端口就够了；想让系统里的程序默认走内核，可以在「设置」里打开「设为系统代理」，停止时会恢复原来的设置。</p>
            <p>启动这类配置前，App 会逐项列出它要改动的地方并再次询问；菜单栏不能启动它们。</p>
          </div>
        </div>
        <button className="btn" onClick={() => setAskTun(true)} disabled={hasTun}>
          {hasTun ? "已有 TUN 入站" : "添加 TUN 入站…"}
        </button>
      </More>

      {editing !== null && (
        <InboundDialog
          config={config}
          index={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onChange(next);
            setEditing(null);
          }}
        />
      )}
      <DeleteDialog
        config={config}
        target={deleting !== null ? { kinds: ["inbound"], tag: tagsOfItem(inbounds[deleting], deleting)[0], what: "入站" } : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) onChange(removeItem(config, ["inbounds"], deleting));
          setDeleting(null);
        }}
      />
      <AlertDialog.Root open={askTun} onOpenChange={setAskTun}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="overlay" />
          <AlertDialog.Content className="dialog">
            <AlertDialog.Title asChild>
              <h2>添加 TUN 入站？</h2>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div>
                <p>保存后，这个配置启动时会：</p>
                <ul className="reasons">
                  <li>创建虚拟网卡，地址 172.19.0.1/30 和 fdfe:dcba:9876::1/126</li>
                  <li>自动改写系统路由（auto_route），让所有流量经过内核</li>
                  <li>开启严格路由（strict_route），不让流量绕过虚拟网卡</li>
                  <li>与 Surge 等接管网络的工具冲突</li>
                </ul>
                <p style={{ marginTop: 12 }}>现在只是写进配置，不会启动内核，也不会改动网络。</p>
              </div>
            </AlertDialog.Description>
            <div className="actions">
              <AlertDialog.Cancel asChild>
                <button className="btn">取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className="btn primary"
                  onClick={() =>
                    onChange(
                      addItem(config, ["inbounds"], {
                        type: "tun",
                        tag: uniqueTag(config, "inbound", "tun-in"),
                        address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
                        auto_route: true,
                        strict_route: true,
                      }),
                    )
                  }
                >
                  写进配置
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

/** The first port from 2080 that no inbound uses and no other app is known for. */
/** The inbound as another type, without the fields that type does not have, as set_system_proxy for socks. */
function withType(node: Node, draft: Json, type: string): Json {
  const next = { ...draft, type };
  const keep = new Set(objectShape(node, next).props.map(([k]) => k));
  return Object.fromEntries(Object.entries(next).filter(([k]) => keep.has(k)));
}

/** A copy of an inbound after it, on a port of its own. */
function duplicateInbound(config: Json, i: number): Json {
  const next = duplicateItem(config, ["inbounds"], i, "inbound");
  return typeof getIn(next, ["inbounds", i + 1, "listen_port"]) === "number" ? setIn(next, ["inbounds", i + 1, "listen_port"], freePort(next)) : next;
}

function freePort(config: Json): number {
  const used = new Set(itemsOf(config, ["inbounds"]).map((i) => i?.listen_port));
  let port = 2080;
  while (used.has(port) || knownPorts[port]) port++;
  return port;
}

function portWarnings(config: Json, port: number | undefined, self: number | null): string[] {
  if (!port) return [];
  const out: string[] = [];
  if (port < 1 || port > 65535) out.push("端口要在 1 到 65535 之间。");
  else if (port < 1024) out.push("1024 以下的端口需要管理员权限，App 无法监听。");
  if (knownPorts[port]) out.push(`${port} 是${knownPorts[port]}，可能已被占用。`);
  itemsOf(config, ["inbounds"]).forEach((it, i) => {
    if (i !== self && it?.listen_port === port) out.push(`入站「${tagsOfItem(it, i)[0]}」已经用了这个端口。`);
  });
  return out;
}

function InboundDialog({ config, index, onClose, onSave }: { config: Json; index: number | null; onClose: () => void; onSave: (next: Json) => void }) {
  const old = index === null ? null : itemsOf(config, ["inbounds"])[index];
  const [draft, setDraft] = useState<Json>(() => (old ? structuredClone(old) : { type: "mixed", tag: uniqueTag(config, "inbound", "mixed-in"), listen: "127.0.0.1", listen_port: freePort(config) }));
  const [custom, setCustom] = useState(() => !!draft.listen && !listens.some((l) => l.value === draft.listen));
  const [error, setError] = useState("");
  const node = def("Inbound");
  const contexts = sectionContexts("inbounds", draft);
  const selfTag = old ? tagsOfItem(old, index!)[0] : undefined;
  const isPort = portTypes.some((p) => p.type === draft.type);
  const set = (k: string, v: Json) => setDraft((d: Json) => (v === undefined ? omitKeys(d, k) : { ...d, [k]: v }));
  const hasSystemProxy = objectShape(node, draft).props.some(([k]) => k === "set_system_proxy");
  const warnings = isPort ? portWarnings(config, draft.listen_port, index) : [];
  const env = { config: index === null ? addItem(config, ["inbounds"], draft) : setIn(config, ["inbounds", index], draft), problems: new Set<string>() };

  const save = () => {
    const tag = String(draft.tag ?? "").trim();
    if (!tag) return setError("给入站起个名字。");
    if (tag !== selfTag && uniqueTag(config, "inbound", tag) !== tag) return setError(`已有名为「${tag}」的入站。`);
    if (isPort && !(draft.listen_port >= 1 && draft.listen_port <= 65535)) return setError("填一个 1 到 65535 之间的端口。");
    const item = { ...draft, tag };
    onSave(index === null ? addItem(config, ["inbounds"], item) : replaceItem(config, ["inbounds"], index, item));
  };

  return (
    <EditDialog open onOpenChange={(o) => !o && onClose()} title={old ? `编辑「${selfTag}」` : "添加本地代理端口"} onSubmit={save} submit={old ? "完成" : "添加"} error={error} wide>
      <FormContext.Provider value={env}>
        {takeoverOf(draft) && (
          <div className="caution">
            <TriangleAlert size={14} />
            <p>这个入站启动时会{takeoverOf(draft)}。启动前 App 会再次询问。</p>
          </div>
        )}
        <Row label="名称">
          <label className="field f-control">
            <input value={draft.tag ?? ""} onChange={(e) => set("tag", e.target.value)} spellCheck={false} />
          </label>
        </Row>
        {isPort || !old ? (
          <>
            <Row label="协议" hint="程序里填代理时选的类型。mixed 同时接受 HTTP 和 SOCKS5。">
              <div className="segmented" role="group">
                {portTypes.map((p) => (
                  <button type="button" key={p.type} aria-pressed={draft.type === p.type} onClick={() => setDraft((d: Json) => withType(node, d, p.type))} title={p.detail}>
                    {p.name}
                  </button>
                ))}
              </div>
            </Row>
            <Row
              label="监听地址"
              hint="谁可以连接这个端口。"
              warn={isPublic(draft.listen) ? "局域网内的设备也能连接这个端口。没有设置用户名和密码时，同一网络里的任何人都能通过它上网。" : undefined}
            >
              <div className="f-inline">
                <select
                  className="select"
                  value={custom ? "__custom" : draft.listen ?? "::"}
                  onChange={(e) => {
                    if (e.target.value === "__custom") return setCustom(true);
                    setCustom(false);
                    set("listen", e.target.value);
                  }}
                >
                  {listens.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.name}
                    </option>
                  ))}
                  <option value="__custom">指定地址…</option>
                </select>
                {custom && (
                  <label className="field">
                    <input value={draft.listen ?? ""} onChange={(e) => set("listen", e.target.value || undefined)} placeholder="例如 192.168.1.10" spellCheck={false} />
                  </label>
                )}
              </div>
            </Row>
            <Row label="端口" hint="程序里填代理时用的端口。" warn={warnings.length ? warnings.join(" ") : undefined}>
              <label className="field f-control narrow">
                <input inputMode="numeric" value={draft.listen_port ?? ""} onChange={(e) => set("listen_port", digits(e.target.value))} />
              </label>
            </Row>
            <More title="高级" detail={hasSystemProxy ? "用户名密码、启动时设为系统代理" : "用户名密码"}>
              <ObjectFields node={node} value={draft} onChange={setDraft} contexts={contexts} path={["inbounds", index ?? 0]} only={["users"]} expanded section="inbounds" />
              {hasSystemProxy && (
                <div className={`f-row inline${draft.set_system_proxy ? " bad" : ""}`}>
                  <div className="f-main">
                    <div className="f-head">
                      <span className="f-label">启动时设为系统代理</span>
                      <code className="f-key">set_system_proxy</code>
                    </div>
                    <div className="f-desc">
                      内核启动时直接改写 macOS 系统代理，停止时直接关闭，不会恢复成原来的设置（例如 Surge 的）。推荐改用「设置 → 设为系统代理」，它会在停止后恢复原设置。
                    </div>
                  </div>
                  <Switch.Root className="switch" checked={!!draft.set_system_proxy} onCheckedChange={(on) => set("set_system_proxy", on || undefined)} aria-label="启动时设为系统代理">
                    <Switch.Thumb className="switch-thumb" />
                  </Switch.Root>
                </div>
              )}
              <ObjectFields node={node} value={draft} onChange={setDraft} contexts={contexts} path={["inbounds", index ?? 0]} hide={["type", "tag", "listen", "listen_port", "users", "set_system_proxy"]} section="inbounds" />
            </More>
          </>
        ) : (
          <ObjectFields node={node} value={draft} onChange={setDraft} contexts={contexts} path={["inbounds", index ?? 0]} hide={["tag"]} section="inbounds" />
        )}
      </FormContext.Provider>
    </EditDialog>
  );
}
