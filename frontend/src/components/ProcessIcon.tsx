// The icon of the app a connection came from, asked of the app once for
// each app and kept; a program on its own shows a generic mark.
import { useEffect, useState } from "react";
import { Terminal } from "lucide-react";
import { box } from "../api";

const icons = new Map<string, Promise<string>>();

/**
 * The app a path is, as the app reads it: on macOS the outermost bundle,
 * so that a helper shows its app's icon; on Windows the program itself.
 */
function bundleOf(path: string): string {
  const i = path.indexOf(".app/");
  if (i >= 0) return path.slice(0, i + 4);
  return /\.exe$/i.test(path) ? path.toLowerCase() : "";
}

function iconOf(path: string): Promise<string> {
  const bundle = bundleOf(path);
  if (!bundle) return Promise.resolve("");
  let icon = icons.get(bundle);
  if (!icon) {
    icon = box.processIcon(path).catch(() => "");
    icons.set(bundle, icon);
    // None now may be one later, as the app asks again after a while.
    icon.then((s) => s || icons.delete(bundle));
  }
  return icon;
}

export function ProcessIcon({ path, size = 14 }: { path?: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    setSrc("");
    if (path) iconOf(path).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [path]);
  if (!path) return null;
  if (!src) return <Terminal size={size - 2} className="proc-icon generic" aria-hidden />;
  return <img className="proc-icon" src={src} width={size} height={size} alt="" />;
}
