import { useEffect, useRef, useState } from "react";
import { box, events, type OutboundGroup, type Snapshot } from "./api";

const initial: Snapshot = {
  status: "stopped",
  profile: "",
  startedAt: 0,
  stats: { upload: 0, download: 0, uploadRate: 0, downloadRate: 0, connections: 0, outboundConnections: 0, memory: 0, goroutines: 0, uploadHistory: [], downHistory: [] },
  line: [],
  mode: { current: "", list: [] },
  warnings: [],
  systemProxy: { enabled: false, active: false },
};

/** The state of the core, as Go sends it. */
export function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState(initial);
  useEffect(() => {
    let live = true;
    // An event newer than the first answer wins over it.
    let evented = false;
    box.state().then((s) => live && !evented && setSnap(s));
    const off = events.state.on((s) => {
      evented = true;
      setSnap(s);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return snap;
}

/** Calls fetch now and every interval while enabled, keeping the last value. */
export function usePoll<T>(fetch: () => Promise<T>, interval: number, enabled: boolean, initialValue: T, deps: unknown[] = []): [T, () => void] {
  const [value, setValue] = useState<T>(initialValue);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setValue(initialValue);
      return;
    }
    let live = true;
    // Only the latest answer counts: a slow one does not overwrite it.
    let sent = 0;
    let shown = 0;
    const run = () => {
      const n = ++sent;
      fetchRef.current().then(
        (v) => {
          if (live && n > shown) {
            shown = n;
            setValue(v);
          }
        },
        () => {},
      );
    };
    run();
    const id = setInterval(run, interval);
    return () => {
      live = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, interval, tick, ...deps]);
  return [value, () => setTick((t) => t + 1)];
}

/** The outbound groups of the running core. */
export function useGroups(running: boolean) {
  return usePoll<OutboundGroup[]>(() => box.groups(), 1500, running, []);
}

/** The time now, updated every second, for uptimes and ages. */
export function useNow(enabled = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
