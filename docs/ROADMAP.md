# Roadmap

Directions, not dates.

Each entry says what it would take to call it done, so that measurement can
remove an entry rather than leaving it to accumulate. Entries leave this file
when they ship, or when a measurement kills them.

**Feature requests are welcome.** Open an issue and describe what you were
trying to write when the software got in the way. A request that names the
situation is worth more than one that names a feature, because the situation
usually admits a better answer than the feature would.

## Next

**Markdown preview viewport.** A new `packages/preview`. The security surface is
part of the design, not a setting: sandboxed, no scripts, no network.

*Done when* a manuscript renders beside the editor, scroll positions stay
locked to each other across a hundred thousand blocks, and a gate proves the
preview frame can reach neither the network nor the filesystem.

**Block-level hits in the sidebar.** The index already works at block level and
every hit carries a location a human would recognise. The bridge still returns
`DocumentRow[]`, so the surface can say which file but not where in it.

*Done when* a search result names the block, clicking it scrolls there, and the
sidebar shows the surrounding sentence rather than the filename alone.

**Precision as a visible choice.** Search has `Exact` and `Loose`, and `Exact`
falls back automatically. Whether the author should ever see that control is
undecided: measurement showed the two modes return identical results for
queries of two to five characters, so a switch would mostly be theatre. What is
*not* theatre is the case where they diverge — one exact hit against five loose
ones.

*Done when* the divergent case is visible without adding a control for the
identical case. If no such design exists, this entry is removed rather than
implemented.

## Later

**Panels on opposite sides.** The layer rules already carry `Side` — the data
model knows a panel can sit opposite another. The animation and the visual
judgment are not made.

*Done when* two panels can hold both sides at once without the manuscript
column reflowing, since reflowing on every panel change is what makes a
two-sided layout unusable.

**Typography preview inside the settings panel.** Adjusting a measure or a
baseline grid while looking at real text, rather than at a number.

*Done when* changing any typographic control updates a live specimen using the
author's own manuscript text, at the author's own font stack.

**Rail virtualisation under a hundred thousand files.** The windowing exists in
`rail-window.ts`; the open question is whether directory reconciliation stays
honest at that size.

*Done when* a 100k-file directory scrolls at the display's refresh rate and a
file added outside the application appears without a manual refresh.

## Under consideration

**Binary size.** 22.08MB in release on Linux, with `strip`, `lto` and
`codegen-units = 1` already on. `panic = "abort"` and dependency pruning (605
crates) are unexplored. `opt-level = "z"` is **not** planned: it trades away
performance work this project has already banked.

*Worth doing only if* a measurable fraction comes off without costing measured
performance. A megabyte is not worth a millisecond on a manuscript this size.

**Windows evidence.** Every number in this repository comes from Linux. WebView2
in a real window, IME behaviour, the installer path, a high-refresh display,
input-to-paint end to end — none of it has been measured on the platform most
authors will use, and none of it will be claimed until it has.

*This one blocks claims rather than features.* A v0.1.6 release surfaced seven
Windows-specific defects in one night, all of the same shape: what Unix
tolerates, Windows enforces. Until these numbers exist, every performance
statement in this repository silently means "on Linux".

## Not planned

**A cloud sync service.** The manuscript is a folder of Markdown on your disk.
Any sync tool you already trust works on it, and none of them need this
application's help.

**An account system.** There is nothing to sign in to. The application makes no
network requests, and adding a reason for it to do so would cost the invariant
that makes everything else here defensible.

**Becoming the format.** RefRain reads and writes Markdown files that other
tools can read. It will not introduce a proprietary container that you would
later need to export from.

---

- [README.md](../README.md) — what RefRain is today
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
