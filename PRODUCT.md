# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(A web frontend rendered in the system WebView of a macOS app built with MyGo; it should feel native to macOS.)

## Stack

Go app on MyGo, sing-box linked in as a Go library. The interface is a React + Vite frontend loaded in the MyGo window, calling Go through MyGo's typed bindings. Chosen by the user over MyGo's native-drawn UI on 2026-10-06.

## Users

- The author, who knows sing-box well, and people they share the app with, who may not know sing-box configuration or its terms.
- Used on a Mac, opened briefly and often: check whether the core runs and how fast, switch a node, and occasionally investigate a problem.

## Product Purpose

A friendly macOS app that brings the sing-box core to everyday users: start and stop the embedded core, see its state and traffic, choose nodes in outbound groups and test their latency, manage configuration files, and look into connections and logs when something goes wrong. Success is an app the user enjoys opening and others can use without reading sing-box docs.

## Positioning

The core runs inside the app itself: no separate binary, no helper service, no system extension. One app, one file to share. Everything a configuration can say is meant to be settable in the interface, so nobody has to read or write JSON.

## Operating Context

- The user's network routing lives in Surge. sing-box must never take over the network by itself: the core starts only when the user explicitly starts it.
- Configurations are sing-box JSON files the user already has, imported into the app.

## Capabilities and Constraints

- Start/stop the core; rates, totals, connection count, memory, last minute of traffic.
- Profiles: import, create, edit JSON, rename, delete (to Trash), set active, check (build without starting, as `sing-box check`, plus a static check of every tag a configuration refers to).
- Visual editing of profiles, two layers over the same JSON: wizards for nodes (with share links), local proxy ports, groups, routing rules, rule sets and DNS; and a form of every field, generated from the core's schema with the Chinese text of its documentation.
- On first open, an offer to import the profiles the app left under its old name (SingBox).
- Every profile keeps its source (the file imported, the subscription as downloaded, the sample created from), shows where it came from and when, whether it was edited since, and compares the two side by side, block by block back to the source. A subscription update merges three ways and keeps the user's edits; where both changed the same thing, the edit stays and the place is listed.
- What runs is visible: the profile running, since when, read only; when it was saved since, a notice, the difference, and a reload.
- Outbound groups: selector switching, URL tests with latency per node; urltest groups choose by themselves.
- Connections: live list with sequence number, per-connection rate, resolved addresses and the log ID that ties a connection to its log lines; group by client or host; search, close one.
- Logs: the core's and the app's own (start, stop, system proxy, subscriptions, profiles), filter by source, level and text, copy, export, clear; says when the configuration's level or `log.disabled` hides lines.
- Diagnostics: the running rules, a DNS query through the core's DNS rules, clear the DNS cache, reset FakeIP.
- Types the build leaves out of the core (as NaïveProxy outbounds) are marked where they are offered.
- Settings: appearance (system/light/dark), data directory.
- Interface language: Simplified Chinese.

## Brand Commitments

- App name: Boxcar (renamed from SingBox; the sing-box license forbids derivative works to use its name or imply association, so the UI says "内核" and credits sing-box only in About and the README). Icon: a white isometric cube on a blue-to-indigo squircle (resources/icon.svg).

## Evidence on Hand

No real usage data, testimonials or node lists; sample data in tests is fake and must not be presented as real.

## Product Principles

1. Status first: whether the core runs, and how well, is answerable at a glance.
2. Nothing happens to the network unless the user asked for it.
3. Plain words over sing-box jargon for shared users; the raw details stay one step away for the expert.
4. Quiet by default, detailed on demand.
