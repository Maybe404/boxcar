// The types this build of the app leaves out of the core: the form offers
// every type of the schema, and marks these, which fail once checked.
import { useEffect, useState } from "react";
import { box } from "../api";

let loaded: Promise<Set<string>> | null = null;

function load(): Promise<Set<string>> {
  loaded ??= box.about().then(
    (a) => new Set(a.missing),
    () => new Set<string>(),
  );
  return loaded;
}

/** The types left out, as "outbounds/naive"; empty until known. */
export function useMissingTypes(): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    load().then((m) => live && setMissing(m));
    return () => {
      live = false;
    };
  }, []);
  return missing;
}

export const missingNote = "此版本未包含";
