# Design

Boxcar.

The window is a transit line. The way traffic takes through the core
(本机 → 入站 → 策略组 → 节点 → 互联网) is drawn as a line with stations, and
the rest of the app uses the same grammar: groups are vertical lines of
stops, a connection's route is a small line.

## Color

Three roles, never more:

| Token | Light | Dark | Use |
|---|---|---|---|
| neutrals (`--bg`, `--text`, `--text-2`, `--text-3`, `--hair`) | white ground, near-black text | `#1f1f21` ground | everything |
| `--line` | `#2e5cf6` | `#5c86ff` | the line while running, the chosen stop, the one primary action, links, focus |
| `--danger` | `#dc3a3f` | `#ff6467` | failure only: errors, latency ≥ 800 ms |

`--line-dim` draws the line while stopped. Pulses on the line are white in
both appearances. The sidebar has no color of its own: the window's
material shows through.

## Type

System faces only, as a Mac app: SF Pro / PingFang SC for text, SF Mono
for addresses and logs. Figures are tabular wherever they change.

| Role | Size / weight |
|---|---|
| State headline | 26 / 700, -0.02em |
| Page title (title bar), group name | 15–17 / 650–700 |
| Body, rows | 13 / 400–560 |
| Secondary, metadata | 11–12 |

## Structure

- No cards and no shadows on content: hierarchy is space and 0.5 px
  hairlines. Shadows belong to things that float (popovers, dialogs, the
  command bar), which are frosted.
- Rows are 40–44 px; titles get more space above than below.
- Line markers: termini are rounded bars, inbounds hollow stations, groups
  interchange capsules, the chosen node a filled stop with a soft ring.

## Motion

One authored moment: when the core starts, the line draws itself from 本机
to 互联网 and the stations follow (1.1 s, ease-out). While running, pulses
flow down (internet → device) and up, more and faster with the rate.
A switched node stays lit for 2.4 s. Everything respects Reduce Motion.

## Components

Radix primitives (popover, dropdown menu, dialog, alert dialog, toggle
group), cmdk for the ⌘K command bar, CodeMirror 6 for profiles, sonner for
toasts, lucide icons at stroke 1.8. All are styled from the tokens above.
