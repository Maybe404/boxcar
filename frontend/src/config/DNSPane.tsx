// DNS: the servers, the rules that choose one for a query, the default,
// the strategy, and FakeIP.
import { useState } from "react";
import { Switch } from "radix-ui";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { DeleteDialog, EditDialog, Empty, ItemMenu, More, PaneHead, Row, type PaneProps } from "./common";
import { FormContext, ObjectFields, RefSelect } from "./SchemaForm";
import { def, objectShape } from "./schema";
import { fieldDoc, fieldLabel, sectionContexts } from "./docs";
import { addItem, disableFakeIP, dnsTemplates, duplicateItem, enableFakeIP, fakeipDefaults, fakeipServer, itemsOf, removeItem, replaceItem, uniqueTag } from "./ops";
import { RuleList, TemplateMenu } from "./RulesPane";
import { tagsOfItem } from "./refs";
import { getIn, setIn, type Json } from "./path";

const serverTypes = [
  { type: "https", name: "DNS over HTTPS", detail: "加密，最常用" },
  { type: "h3", name: "DNS over HTTP/3", detail: "加密，基于 QUIC" },
  { type: "tls", name: "DNS over TLS", detail: "加密" },
  { type: "quic", name: "DNS over QUIC", detail: "加密" },
  { type: "udp", name: "普通 DNS（UDP）", detail: "不加密" },
  { type: "tcp", name: "普通 DNS（TCP）", detail: "不加密" },
  { type: "local", name: "系统 DNS", detail: "用 macOS 的设置" },
  { type: "dhcp", name: "DHCP 下发的 DNS", detail: "" },
  { type: "hosts", name: "hosts 文件", detail: "" },
  { type: "fakeip", name: "FakeIP", detail: "返回虚假地址，透明代理用" },
];

/** What each type of server needs, asked first. */
const serverEssentials: Record<string, string[]> = {
  https: ["server", "server_port", "path", "detour", "domain_resolver"],
  h3: ["server", "server_port", "path", "detour", "domain_resolver"],
  tls: ["server", "server_port", "detour", "domain_resolver"],
  quic: ["server", "server_port", "detour", "domain_resolver"],
  udp: ["server", "server_port", "detour", "domain_resolver"],
  tcp: ["server", "server_port", "detour", "domain_resolver"],
  local: ["prefer_go"],
  dhcp: ["interface"],
  hosts: ["path", "predefined"],
  fakeip: ["inet4_range", "inet6_range"],
};

const strategies = [
  { value: "", name: "默认" },
  { value: "prefer_ipv4", name: "优先 IPv4" },
  { value: "prefer_ipv6", name: "优先 IPv6" },
  { value: "ipv4_only", name: "只用 IPv4" },
  { value: "ipv6_only", name: "只用 IPv6" },
];

const isIP = (s: Json) => typeof s === "string" && (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":"));

export function DNSPane({ config, onChange }: PaneProps) {
  const servers = itemsOf(config, ["dns", "servers"]);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [fakeIndex, fakeip] = fakeipServer(config);
  const final = getIn(config, ["dns", "final"]);
  const firstServer = servers.length ? tagsOfItem(servers[0], 0)[0] : "";
  const set = (path: (string | number)[], v: Json) => onChange(setIn(config, path, v));

  return (
    <div className="pane">
      <PaneHead title="DNS" detail="内核怎样解析域名。没有设置时，用系统 DNS 直接查询。">
        <TemplateMenu templates={dnsTemplates} config={config} onChange={onChange} />
      </PaneHead>

      <FormContext.Provider value={{ config, problems: new Set() }}>
        <div className="f-row inline">
          <div className="f-main">
            <div className="f-head">
              <span className="f-label">默认 DNS 服务器</span>
              <code className="f-key">dns.final</code>
            </div>
            <div className="f-desc">没有匹配任何 DNS 规则的查询用它。不设置时用第一个服务器{firstServer ? `（${firstServer}）` : "（系统 DNS）"}。</div>
          </div>
          <RefSelect kind="dns_server" value={final} onChange={(v) => set(["dns", "final"], v)} placeholder={`（第一个${firstServer ? `：${firstServer}` : ""}）`} />
        </div>
        <div className="f-row inline">
          <div className="f-main">
            <div className="f-head">
              <span className="f-label">IPv4 / IPv6</span>
              <code className="f-key">dns.strategy</code>
            </div>
            <div className="f-desc">解析域名时要哪种地址。网络不支持 IPv6 时选「只用 IPv4」。</div>
          </div>
          <select className="select" value={getIn(config, ["dns", "strategy"]) ?? ""} onChange={(e) => set(["dns", "strategy"], e.target.value || undefined)}>
            {strategies.map((s) => (
              <option key={s.value} value={s.value}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="f-row inline">
          <div className="f-main">
            <div className="f-head">
              <span className="f-label">FakeIP</span>
            </div>
            <div className="f-desc">对 A 和 AAAA 查询返回虚假地址，连接时再还原成域名。只有 TUN 等透明代理入站会用到；只用本地端口时不需要。</div>
          </div>
          <Switch.Root className="switch" checked={fakeIndex >= 0} onCheckedChange={(on) => onChange(on ? enableFakeIP(config) : disableFakeIP(config))} aria-label="FakeIP">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
        </div>
        {fakeIndex >= 0 && (
          <div className="f-inline-pair">
            <Row label="IPv4 地址段">
              <label className="field f-control">
                <input value={fakeip?.inet4_range ?? ""} placeholder={fakeipDefaults.inet4_range} onChange={(e) => set(["dns", "servers", fakeIndex, "inet4_range"], e.target.value || undefined)} spellCheck={false} />
              </label>
            </Row>
            <Row label="IPv6 地址段">
              <label className="field f-control">
                <input value={fakeip?.inet6_range ?? ""} placeholder={fakeipDefaults.inet6_range} onChange={(e) => set(["dns", "servers", fakeIndex, "inet6_range"], e.target.value || undefined)} spellCheck={false} />
              </label>
            </Row>
          </div>
        )}
      </FormContext.Provider>

      <div className="pane-sub">
        <h4>服务器</h4>
        <button className="btn ghost" onClick={() => setEditing("new")}>
          <Plus size={13} /> 添加服务器
        </button>
      </div>
      {servers.length === 0 ? (
        <Empty title="还没有 DNS 服务器">内核会用系统 DNS。添加加密 DNS，或用「模板」里的「国内外分流 DNS」。</Empty>
      ) : (
        <ul className="items">
          {servers.map((s, i) => {
            const tag = tagsOfItem(s, i)[0];
            return (
              <li key={i}>
                <div className="item" role="button" tabIndex={0} onClick={() => setEditing(i)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(i)}>
                  <span className="item-main">
                    <b className="ellipsis">
                      {tag}
                      {(final ?? firstServer) === tag && <span className="badge line">默认</span>}
                    </b>
                    <span className="ellipsis">
                      {serverTypes.find((t) => t.type === s?.type)?.name ?? s?.type ?? "旧格式"}
                      {s?.server && ` · ${s.server}`}
                      {s?.detour && ` · 经过 ${s.detour}`}
                    </span>
                  </span>
                  <ItemMenu
                    actions={[
                      { label: "编辑…", icon: <Pencil size={14} />, onSelect: () => setEditing(i) },
                      { label: "复制一份", icon: <Copy size={14} />, onSelect: () => onChange(duplicateItem(config, ["dns", "servers"], i, "dns_server")) },
                      { label: "设为默认", onSelect: () => set(["dns", "final"], tag), disabled: final === tag || s?.type === "fakeip" },
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

      <div className="pane-sub">
        <h4>DNS 规则</h4>
      </div>
      <RuleList config={config} onChange={onChange} path={["dns", "rules"]} kind="dns" finalText={`用 ${final || firstServer || "系统 DNS"} 查询（默认）`} />

      <More title="DNS 的全部设置" detail="缓存、超时、客户端子网等">
        <FormContext.Provider value={{ config, problems: new Set() }}>
          <ObjectFields node={def("DNS")} value={getIn(config, ["dns"]) ?? {}} onChange={(v) => set(["dns"], v)} contexts={["dns"]} path={["dns"]} hide={["servers", "rules", "final", "strategy"]} section="dns" />
        </FormContext.Provider>
      </More>

      {editing !== null && (
        <ServerDialog
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
        target={deleting !== null ? { kinds: ["dns_server"], tag: tagsOfItem(servers[deleting], deleting)[0], what: "DNS 服务器" } : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) onChange(removeItem(config, ["dns", "servers"], deleting));
          setDeleting(null);
        }}
      />
    </div>
  );
}

function ServerDialog({ config, index, onClose, onSave }: { config: Json; index: number | null; onClose: () => void; onSave: (next: Json) => void }) {
  const old = index === null ? null : itemsOf(config, ["dns", "servers"])[index];
  const [draft, setDraft] = useState<Json>(() => (old ? structuredClone(old) : { type: "https", tag: uniqueTag(config, "dns_server", "dns"), server: "" }));
  const [error, setError] = useState("");
  const selfTag = old ? tagsOfItem(old, index!)[0] : undefined;
  const type: string = draft.type ?? "";
  const node = def("DNSServer");
  const contexts = sectionContexts("dns.servers", draft);
  const keys = (serverEssentials[type] ?? []).filter((k) => k !== "domain_resolver" || (draft.server && !isIP(draft.server)));
  const env = { config: index === null ? addItem(config, ["dns", "servers"], draft) : setIn(config, ["dns", "servers", index], draft), problems: new Set<string>() };
  const legacy = !!old && !type;

  const save = () => {
    const tag = String(draft.tag ?? "").trim();
    if (!tag) return setError("给服务器起个名字，规则里用它引用。");
    if (tag !== selfTag && uniqueTag(config, "dns_server", tag) !== tag) return setError(`已有名为「${tag}」的 DNS 服务器。`);
    const missing = [...objectShape(node, draft).required].filter((k) => k !== "type" && (draft[k] === undefined || draft[k] === ""));
    if (missing.length) return setError(`还没填：${missing.map((k) => fieldLabel(k, fieldDoc(contexts, k).doc)).join("、")}。`);
    const item = { ...draft, tag };
    onSave(index === null ? addItem(config, ["dns", "servers"], item) : replaceItem(config, ["dns", "servers"], index, item));
  };

  return (
    <EditDialog open onOpenChange={(o) => !o && onClose()} title={old ? `编辑「${selfTag}」` : "添加 DNS 服务器"} onSubmit={save} submit={old ? "完成" : "添加"} error={error} wide>
      <FormContext.Provider value={env}>
        {legacy && <p className="f-desc">这是旧格式的 DNS 服务器（没有 type 字段），内核会提示已废弃。可以选一个类型改成新格式。</p>}
        <Row label="类型" inline>
          <select
            className="select"
            value={type}
            onChange={(e) => {
              const t = e.target.value;
              setDraft((d: Json) => {
                const keep = new Set(["tag", ...(serverEssentials[t] ?? [])]);
                const next: Json = { type: t };
                for (const [k, v] of Object.entries(d)) if (keep.has(k)) next[k] = v;
                return next;
              });
            }}
          >
            {legacy && <option value="">旧格式</option>}
            {serverTypes.map((s) => (
              <option key={s.type} value={s.type}>
                {s.name}
                {s.detail && ` · ${s.detail}`}
              </option>
            ))}
            {type && !serverTypes.some((s) => s.type === type) && <option value={type}>{type}</option>}
          </select>
        </Row>
        <Row label="名称" hint="DNS 规则里用这个名字引用它。">
          <label className="field f-control">
            <input value={draft.tag ?? ""} onChange={(e) => setDraft((d: Json) => ({ ...d, tag: e.target.value }))} spellCheck={false} />
          </label>
        </Row>
        {keys.length > 0 && <ObjectFields node={node} value={draft} onChange={setDraft} contexts={contexts} path={["dns", "servers", index ?? 0]} only={keys} expanded section="dns.servers" />}
        {!!draft.server && !isIP(draft.server) && !draft.domain_resolver && !getIn(config, ["route", "default_domain_resolver"]) && (
          <p className="f-desc">服务器地址是域名，需要先解析：设置上面的「域名解析器」，或在「全部字段 · 路由」里设置默认域名解析器。</p>
        )}
        <More>
          <ObjectFields node={node} value={draft} onChange={setDraft} contexts={contexts} path={["dns", "servers", index ?? 0]} hide={["tag", ...keys]} section="dns.servers" />
        </More>
      </FormContext.Provider>
    </EditDialog>
  );
}

