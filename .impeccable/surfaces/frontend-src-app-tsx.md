---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/App.tsx"
related_targets: []
---

Scope: the whole SingBox window (frontend/), Operate mode. Audience: the author and people they share it with; job: start/stop the core, see speed, switch nodes, troubleshoot.

## Direction contract

THESIS: The core is a transit line: 本机 → 入站 → 策略组 → 节点 → 互联网, drawn and live. Refuses the stat-card dashboard with a line chart.
OWN-WORLD: Neutral ground, one line-blue for the line and the single primary action, red only for failure. Round stations on 2px lines, 1-device-pixel hairlines, tabular figures in place; no cards, no shadows on content.
STORY: Opening the app answers "is it running, through which node, how fast" from the line; a station opens its choices; groups read as vertical lines of stations.
FIRST VIEWPORT: Top third: the line across the content width with labeled stations, dots flowing while running. Beneath: one state sentence with the 启动/停止 button left-aligned, then a two-column hairline table of figures and the latest connections.
FORM: transit line diagram, candidate 3 of 7, seed 7a5d41cb.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
