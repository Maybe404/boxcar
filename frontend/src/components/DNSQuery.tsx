// A lookup through the running core's DNS, on the settings page and the DNS
// records beside the connections.
import { useState } from "react";
import { box, errorText, type DNSResult } from "../api";

const queryTypes = ["A", "AAAA", "CNAME", "HTTPS", "MX", "TXT"];

/** A lookup through the running core's DNS, routed by its DNS rules as an app's would be. */
export function DNSQuery({ running }: { running: boolean }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("A");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; type: string; r?: DNSResult; error?: string } | null>(null);
  const query = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      setResult({ name: name.trim(), type, r: await box.queryDNS(name, type) });
    } catch (err) {
      setResult({ name: name.trim(), type, error: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting" style={{ flexWrap: "wrap" }}>
      <div className="what">
        DNS 查询
        <span>按配置的 DNS 规则查询，结果与应用实际拿到的一致；会真的发出查询。</span>
      </div>
      <form
        className="control"
        style={{ display: "flex", gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          query();
        }}
      >
        <label className="field" style={{ width: 180 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 github.com" aria-label="域名" spellCheck={false} disabled={!running} />
        </label>
        <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="记录类型" disabled={!running}>
          {queryTypes.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <button className="btn" type="submit" disabled={!running || busy || !name.trim()}>
          {busy ? "查询中…" : "查询"}
        </button>
      </form>
      {result && (
        <div className="dns-result selectable">
          {result.error ? (
            <span className="danger-text">{result.error}</span>
          ) : result.r && result.r.answers.length === 0 ? (
            <span className="faint">
              {result.name} 没有 {result.type} 记录（{result.r.rcode}，{result.r.took} ms）
            </span>
          ) : (
            <>
              {result.r?.answers.map((a, i) => (
                <div key={i}>
                  <span className="faint">{a.type}</span> {a.data} <span className="faint">TTL {a.ttl}s</span>
                </div>
              ))}
              <div className="faint">
                {result.r?.rcode} · {result.r?.took} ms
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
