// What a page that needs the core shows while it is not running.
import type { Status } from "../api";
import { PowerButton } from "./Power";

export function Stopped({ title, detail, status, profile }: { title: string; detail: string; status: Status; profile: string }) {
  return (
    <div className="empty">
      <svg className="mark" width="132" height="28" viewBox="0 0 132 28" aria-hidden="true">
        <line x1="6" x2="126" y1="14" y2="14" stroke="var(--line-dim)" strokeWidth="3" strokeLinecap="round" />
        <rect x="2.5" y="3" width="7" height="22" rx="3.5" fill="var(--line-dim)" />
        <circle cx="46" cy="14" r="6" fill="var(--bg)" stroke="var(--line-dim)" strokeWidth="3" />
        <rect x="74" y="7" width="22" height="14" rx="7" fill="var(--bg)" stroke="var(--line-dim)" strokeWidth="3" />
        <rect x="122.5" y="3" width="7" height="22" rx="3.5" fill="var(--line-dim)" />
      </svg>
      <h2>{title}</h2>
      <p>{detail}</p>
      <PowerButton status={status} disabled={!profile} />
    </div>
  );
}
