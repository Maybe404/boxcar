import { ArrowLeftRight, FileJson, Route, ScrollText, Settings2, Waypoints } from "lucide-react";

export const pages = [
  { id: "line", title: "线路", icon: Route, key: "⌘1" },
  { id: "nodes", title: "节点", icon: Waypoints, key: "⌘2" },
  { id: "connections", title: "连接", icon: ArrowLeftRight, key: "⌘3" },
  { id: "logs", title: "日志", icon: ScrollText, key: "⌘4" },
  { id: "profiles", title: "配置", icon: FileJson, key: "⌘5" },
  { id: "settings", title: "设置", icon: Settings2, key: "⌘," },
] as const;

export type PageId = (typeof pages)[number]["id"];
