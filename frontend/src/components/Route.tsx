// A connection's way through the core: its inbound and the outbounds it
// went through, as stops of a small line.
export function Route({ chain, inbound, outbound }: { chain: string[]; inbound: string; outbound: string }) {
  const stops = [inbound, ...(chain.length ? chain : [outbound])].filter(Boolean);
  return (
    <span className="route" title={stops.join(" → ")}>
      {stops.map((s, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 && <i />}
          {i === stops.length - 1 ? <b>{s}</b> : <span>{s}</span>}
        </span>
      ))}
    </span>
  );
}
