// The platform the page runs on: macOS or Windows, which name keys and
// places differently. The preview shows Windows with ?platform=windows.
export const isWindows =
  typeof navigator !== "undefined" &&
  (/Windows/.test(navigator.userAgent) || (typeof location !== "undefined" && new URLSearchParams(location.search).get("platform") === "windows"));

/** The modifier of shortcuts, as shown before a key: ⌘K, Ctrl+K. */
export const mod = isWindows ? "Ctrl+" : "⌘";
/** Shift, as shown in a shortcut. */
export const shift = isWindows ? "Shift+" : "⇧";
/** The system, in sentences. */
export const osName = isWindows ? "Windows" : "macOS";
/** Where files are shown. */
export const fileManager = isWindows ? "资源管理器" : "访达";
/** Where the app's icon is beside the clock. */
export const trayPlace = isWindows ? "通知区域" : "菜单栏";
/** This computer. */
export const thisComputer = isWindows ? "这台电脑" : "这台 Mac";

/** Whether the shortcut modifier is held: Command on macOS, Ctrl on Windows. */
export function modHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isWindows ? e.ctrlKey : e.metaKey;
}
