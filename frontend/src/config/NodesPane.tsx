// Nodes: the outbounds that reach a server, and endpoints. Adding one asks
// for the protocol, then only what it needs; the rest folds away. Share
// links of other clients can be pasted in.
import { useEffect, useMemo, useState } from "react";
import { Copy, Link2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { errorText } from "../api";
import { DeleteDialog, EditDialog, Empty, ItemMenu, More, PaneHead, Row, ToggleChips, type PaneProps } from "./common";
import { FormContext, ObjectFields } from "./SchemaForm";
import { def, objectShape } from "./schema";
import { sectionContexts, fieldDoc, fieldLabel } from "./docs";
import { addItem, builtinTypes, duplicateItem, isGroup, itemsOf, kindsOf, removeItem, replaceItem, uniqueTag } from "./ops";
import { parseShareText } from "./share";
import { tagsOfItem } from "./refs";
import { getIn, isObject, omitKeys, setIn, type Json, type Path } from "./path";

interface NodeRef {
  section: "outbounds" | "endpoints";
  index: number;
  item: Json;
}

/** The protocols offered first, as people know them. */
const protocols: { type: string; name: string; section?: "endpoints" }[] = [
  { type: "vless", name: "VLESS" },
  { type: "vmess", name: "VMess" },
  { type: "trojan", name: "Trojan" },
  { type: "shadowsocks", name: "Shadowsocks" },
  { type: "hysteria2", name: "Hysteria 2" },
  { type: "tuic", name: "TUIC" },
  { type: "anytls", name: "AnyTLS" },
  { type: "hysteria", name: "Hysteria" },
  { type: "naive", name: "NaïveProxy" },
  { type: "shadowtls", name: "ShadowTLS" },
  { type: "socks", name: "SOCKS" },
  { type: "http", name: "HTTP" },
  { type: "ssh", name: "SSH" },
  { type: "wireguard", name: "WireGuard", section: "endpoints" },
];

/** What each protocol needs, asked first; the rest is under 全部字段. */
const essentials: Record<string, string[]> = {
  vless: ["server", "server_port", "uuid", "flow"],
  vmess: ["server", "server_port", "uuid", "security", "alter_id"],
  trojan: ["server", "server_port", "password"],
  shadowsocks: ["server", "server_port", "method", "password", "plugin", "plugin_opts"],
  hysteria2: ["server", "server_port", "password", "up_mbps", "down_mbps", "obfs"],
  tuic: ["server", "server_port", "uuid", "password", "congestion_control", "udp_relay_mode"],
  anytls: ["server", "server_port", "password"],
  hysteria: ["server", "server_port", "auth_str", "up_mbps", "down_mbps", "obfs"],
  naive: ["server", "server_port", "username", "password"],
  shadowtls: ["server", "server_port", "version", "password"],
  socks: ["server", "server_port", "version", "username", "password"],
  http: ["server", "server_port", "username", "password"],
  ssh: ["server", "server_port", "user", "password", "private_key"],
  snell: ["server", "server_port", "version", "psk"],
  wireguard: ["address", "private_key", "peers", "mtu"],
};

/** Protocols over TLS; for some it is not optional. */
const withTLS = new Set(["vless", "vmess", "trojan", "hysteria2", "tuic", "anytls", "hysteria", "naive", "http", "shadowtls"]);
const tlsRequired = new Set(["trojan", "hysteria2", "tuic", "anytls", "hysteria", "naive", "shadowtls"]);
const withTransport = new Set(["vless", "vmess", "trojan"]);

const transports = [
  { value: "", name: "无（TCP）" },
  { value: "ws", name: "WebSocket" },
  { value: "grpc", name: "gRPC" },
  { value: "http", name: "HTTP/2" },
  { value: "httpupgrade", name: "HTTPUpgrade" },
  { value: "quic", name: "QUIC" },
];

const tlsFields = ["enabled", "server_name", "insecure", "alpn", "utls", "reality"];

function nodesOf(config: Json): NodeRef[] {
  const out: NodeRef[] = [];
  itemsOf(config, ["outbounds"]).forEach((item, index) => !isGroup(item) && out.push({ section: "outbounds", index, item }));
  itemsOf(config, ["endpoints"]).forEach((item, index) => out.push({ section: "endpoints", index, item }));
  return out;
}

const tagOf = (n: NodeRef) => tagsOfItem(n.item, n.index)[0];

export function NodesPane({ config, onChange, runtime }: PaneProps) {
  const nodes = nodesOf(config);
  const groups = itemsOf(config, ["outbounds"]).filter(isGroup);
  const [editing, setEditing] = useState<NodeRef | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<NodeRef | null>(null);
  const [delays, setDelays] = useState<Record<string, number | "testing" | "failed">>({});

  const test = async (tag: string) => {
    setDelays((d) => ({ ...d, [tag]: "testing" }));
    try {
      const ms = await runtime.testOutbound(tag);
      setDelays((d) => ({ ...d, [tag]: ms }));
    } catch (err) {
      setDelays((d) => ({ ...d, [tag]: "failed" }));
      toast.error(`${tag} 测速失败`, { description: errorText(err) });
    }
  };

  return (
    <div className="pane">
      <PaneHead title="节点" detail="出站代理服务器。添加后可以放进策略组，或在分流规则里直接使用。">
        <button className="btn" onClick={() => setImporting(true)}>
          <Link2 size={13} /> 粘贴分享链接
        </button>
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={13} /> 添加节点
        </button>
      </PaneHead>
      {nodes.length === 0 ? (
        <Empty title="还没有节点">点「添加节点」逐项填写，或「粘贴分享链接」从其他客户端导入。</Empty>
      ) : (
        <ul className="items">
          {nodes.map((n) => {
            const tag = tagOf(n);
            const type = n.item?.type ?? "";
            const builtin = builtinTypes.has(type);
            const where = typeof n.item?.server === "string" ? `${n.item.server}${n.item.server_port ? `:${n.item.server_port}` : ""}` : n.section === "endpoints" ? "端点" : "";
            const delay = delays[tag];
            return (
              <li key={`${n.section}-${n.index}`}>
                <div className="item" role="button" tabIndex={0} onClick={() => setEditing(n)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(n)}>
                  <span className="item-main">
                    <b className="ellipsis">{tag}</b>
                    <span className="ellipsis">
                      {type}
                      {where && ` · ${where}`}
                      {builtin && " · 内置"}
                    </span>
                  </span>
                  {runtime.live && !builtin && (
                    <button
                      className={`delay${typeof delay === "number" && delay >= 800 ? " slow" : ""}${delay === "failed" ? " slow" : ""}`}
                      title="测试延迟（经过内核）"
                      onClick={(e) => {
                        e.stopPropagation();
                        test(tag);
                      }}
                    >
                      {delay === "testing" ? "…" : delay === "failed" ? "失败" : typeof delay === "number" ? `${delay} ms` : <Zap size={12} />}
                    </button>
                  )}
                  <ItemMenu
                    actions={[
                      { label: "编辑…", icon: <Pencil size={14} />, onSelect: () => setEditing(n) },
                      { label: "复制一份", icon: <Copy size={14} />, onSelect: () => onChange(duplicateItem(config, [n.section], n.index, "outbound")) },
                      { label: "-", onSelect: () => {} },
                      { label: "删除…", icon: <Trash2 size={14} />, onSelect: () => setDeleting(n) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {groups.length === 0 && nodes.length > 1 && <p className="pane-note">有多个节点时，可以在「策略组」里建一个组，在它们之间切换或自动选最快的。</p>}

      {editing && (
        <NodeDialog
          config={config}
          target={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onChange(next);
            setEditing(null);
          }}
        />
      )}
      <ImportDialog open={importing} onOpenChange={setImporting} config={config} onChange={onChange} />
      <DeleteDialog
        config={config}
        target={deleting ? { kinds: kindsOf([deleting.section]), tag: tagOf(deleting), what: "节点" } : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) onChange(removeItem(config, [deleting.section], deleting.index));
          setDeleting(null);
        }}
      />
    </div>
  );
}

/** The groups a new node joins: the default route's group, when a selector. */
function defaultGroups(config: Json): string[] {
  const final = getIn(config, ["route", "final"]);
  const group = itemsOf(config, ["outbounds"]).find((o) => isGroup(o) && o.tag === final);
  return group ? [group.tag] : [];
}

function addToGroups(config: Json, tags: string[], groups: string[]): Json {
  let next = config;
  itemsOf(next, ["outbounds"]).forEach((o, i) => {
    if (isGroup(o) && groups.includes(o.tag)) {
      const members: string[] = Array.isArray(o.outbounds) ? o.outbounds : [];
      next = setIn(next, ["outbounds", i, "outbounds"], [...members, ...tags.filter((t) => !members.includes(t))]);
    }
  });
  return next;
}

function NodeDialog({ config, target, onClose, onSave }: { config: Json; target: NodeRef | null; onClose: () => void; onSave: (next: Json) => void }) {
  const [draft, setDraft] = useState<Json>(target ? structuredClone(target.item) : null);
  const [section, setSection] = useState<"outbounds" | "endpoints">(target?.section ?? "outbounds");
  const [join, setJoin] = useState<string[]>(() => defaultGroups(config));
  const [error, setError] = useState("");
  const groups = itemsOf(config, ["outbounds"]).filter(isGroup);

  const choose = (type: string, sec: "outbounds" | "endpoints" = "outbounds") => {
    const item: Json = { type, tag: uniqueTag(config, "outbound", protocols.find((p) => p.type === type)?.name ?? type) };
    if (tlsRequired.has(type)) item.tls = { enabled: true };
    if (type === "wireguard") item.peers = [{}];
    setSection(sec);
    setDraft(item);
  };

  if (!draft) {
    return (
      <EditDialog open onOpenChange={(o) => !o && onClose()} title="添加节点" description="选择节点的协议，可以在机场或服务器的说明里找到。" onSubmit={() => {}} submit={null} wide>
        <div className="protocols">
          {protocols.map((p) => (
            <button type="button" key={p.type} className="protocol" onClick={() => choose(p.type, p.section ?? "outbounds")}>
              <b>{p.name}</b>
              <span className="mono">{p.type}</span>
            </button>
          ))}
        </div>
        <OtherTypes onChoose={(t) => choose(t)} />
      </EditDialog>
    );
  }

  const type: string = draft.type ?? "";
  const node = def(section === "endpoints" ? "Endpoint" : "Outbound");
  const contexts = sectionContexts(section, draft);
  const keys = essentials[type] ?? [];
  const tagValue: string = typeof draft.tag === "string" ? draft.tag : "";
  const selfTag = target ? tagsOfItem(target.item, target.index)[0] : undefined;
  const set = (k: string, v: Json) => setDraft((d: Json) => (v === undefined ? omitKeys(d, k) : { ...d, [k]: v }));

  const save = () => {
    const tag = tagValue.trim();
    if (!tag) return setError("给节点起个名字。");
    if (tag !== selfTag && uniqueTag(config, "outbound", tag) !== tag) return setError(`已有名为「${tag}」的出站。`);
    const missing = [...objectShape(node, draft).required].filter((k) => k !== "type" && (draft[k] === undefined || draft[k] === ""));
    if (missing.length) return setError(`还没填：${missing.map((k) => fieldLabel(k, fieldDoc(contexts, k).doc)).join("、")}。`);
    const item = { ...draft, tag };
    if (target) onSave(replaceItem(config, [target.section], target.index, item));
    else onSave(addToGroups(addItem(config, [section], item), [tag], join));
  };

  const env = { config: target ? setIn(config, [target.section, target.index], draft) : addItem(config, [section], draft), problems: new Set<string>() };
  const transportType = isObject(draft.transport) ? draft.transport.type ?? "" : "";
  return (
    <EditDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={target ? `编辑「${selfTag}」` : `添加 ${protocols.find((p) => p.type === type)?.name ?? type} 节点`}
      onSubmit={save}
      submit={target ? "完成" : "添加"}
      error={error}
      wide
      extra={
        !target && (
          <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
            换个协议
          </button>
        )
      }
    >
      <FormContext.Provider value={env}>
        <Row label="名称" hint="在策略组和规则里用这个名字指代它。">
          <label className="field f-control">
            <input value={tagValue} onChange={(e) => set("tag", e.target.value)} autoFocus spellCheck={false} />
          </label>
        </Row>
        {keys.length > 0 && <ObjectFields node={node} value={draft} onChange={setDraft} contexts={contexts} path={[section, target?.index ?? 0]} only={keys} expanded section={section} />}
        {withTLS.has(type) && (
          <section className="sub">
            <h4>TLS</h4>
            <ObjectFields
              node={def("OutboundTLSOptions")}
              value={draft.tls ?? {}}
              onChange={(v) => set("tls", tlsRequired.has(type) ? { ...v, enabled: true } : Object.keys(v ?? {}).length ? v : undefined)}
              contexts={["shared/tls"]}
              path={[section, target?.index ?? 0, "tls"]}
              only={tlsRequired.has(type) ? tlsFields.filter((k) => k !== "enabled") : tlsFields}
              expanded
            />
          </section>
        )}
        {withTransport.has(type) && (
          <section className="sub">
            <h4>传输层</h4>
            <Row label="传输方式" hint="与服务器的设置一致；不确定时选「无」。" inline>
              <select className="select" value={transportType} onChange={(e) => set("transport", e.target.value ? { type: e.target.value } : undefined)}>
                {transports.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Row>
            {transportType && (
              <ObjectFields node={def("V2RayTransport")} value={draft.transport} onChange={(v) => set("transport", v)} contexts={["shared/v2ray-transport"]} path={[section, target?.index ?? 0, "transport"]} hide={["type"]} expanded />
            )}
          </section>
        )}
        {!target && groups.length > 0 && (
          <Row label="加入策略组" hint="添加后放进这些组，可以在组里切换到它。">
            <ToggleChips options={groups.map((g) => g.tag)} value={join} onChange={setJoin} />
          </Row>
        )}
        <More detail="拨号、多路复用等，一般不用改">
          <ObjectFields node={node} value={draft} onChange={setDraft} contexts={contexts} path={[section, target?.index ?? 0]} hide={["tag", ...keys, ...(withTLS.has(type) ? ["tls"] : []), ...(withTransport.has(type) ? ["transport"] : [])]} section={section} />
        </More>
      </FormContext.Provider>
    </EditDialog>
  );
}

/** The other types of outbounds, for those not offered first. */
function OtherTypes({ onChoose }: { onChoose: (type: string) => void }) {
  const types = useMemo(() => {
    const disc = objectShape(def("Outbound"), {}).discriminators[0];
    const shown = new Set(protocols.map((p) => p.type));
    return [...new Set((disc?.variants ?? []).map((v) => String(v.value)))].filter((t) => !shown.has(t) && t !== "selector" && t !== "urltest");
  }, []);
  return (
    <div className="other-types">
      <span className="faint">其他类型</span>
      <select className="select" value="" onChange={(e) => e.target.value && onChoose(e.target.value)}>
        <option value="">选择…</option>
        {types.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

function ImportDialog({ open, onOpenChange, config, onChange }: { open: boolean; onOpenChange: (o: boolean) => void; config: Json; onChange: (next: Json) => void }) {
  const [text, setText] = useState("");
  const [join, setJoin] = useState<string[]>([]);
  const results = useMemo(() => parseShareText(text), [text]);
  const ok = results.filter((r) => r.ok);
  const groups = itemsOf(config, ["outbounds"]).filter(isGroup);
  // Opened afresh each time, joining the default route's group.
  useEffect(() => {
    if (!open) return;
    setText("");
    setJoin(defaultGroups(config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <EditDialog
      open={open}
      onOpenChange={onOpenChange}
      title="粘贴分享链接"
      description="每行一个 vless://、vmess://、trojan://、ss://、hysteria2://、tuic://、anytls:// 等链接；也可以粘贴 base64 订阅内容或出站的 JSON。"
      submit={ok.length ? `导入 ${ok.length} 个节点` : "导入"}
      wide
      onSubmit={() => {
        if (!ok.length) return;
        let next = config;
        const tags: string[] = [];
        for (const r of ok) {
          if (!r.ok) continue;
          const tag = uniqueTag(next, "outbound", String(r.outbound.tag ?? r.outbound.type));
          const section: Path = r.outbound.type === "wireguard" ? ["endpoints"] : ["outbounds"];
          next = addItem(next, section, { ...r.outbound, tag });
          tags.push(tag);
        }
        onChange(addToGroups(next, tags, join));
        toast.success(`已导入 ${tags.length} 个节点`);
        onOpenChange(false);
      }}
    >
      <textarea className="paste mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="vless://…" spellCheck={false} autoFocus rows={6} />
      {results.length > 0 && (
        <ul className="paste-results">
          {results.map((r, i) => (
            <li key={i} className={r.ok ? "" : "bad"}>
              {r.ok ? (
                <>
                  <b className="ellipsis">{r.outbound.tag}</b>
                  <span className="faint ellipsis">
                    {r.outbound.type}{r.outbound.server ? ` · ${r.outbound.server}${r.outbound.server_port ? `:${r.outbound.server_port}` : ""}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <span className="ellipsis mono">{r.line.slice(0, 48)}</span>
                  <span className="danger-text">{r.error}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <Row label="加入策略组">
          <ToggleChips options={groups.map((g) => g.tag)} value={join} onChange={setJoin} />
        </Row>
      )}
    </EditDialog>
  );
}
