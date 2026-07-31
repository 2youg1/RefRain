# Roadmap

Directions, not dates. Each item below has evidence behind it — either
measurements that showed it is worth doing, or a gap found while doing something
else. Items are removed when they ship, or when measurement kills them.

## Next

**Markdown preview viewport.** A new `packages/preview`. The security surface is
part of the design, not a setting: sandboxed, no scripts, no network. This is a
new capability rather than a fix, which is why it is not further along.

**Precision as a visible choice.** Search already has `Exact` and `Loose`, and
`Exact` falls back automatically. Whether the author should ever see that
control is undecided: measurement showed the two modes return identical results
for queries of two to five characters, so a switch would mostly be theatre.
What is *not* theatre is the case where they diverge — one exact hit against
five loose ones — and that is worth surfacing somehow.

**Block-level hits in the sidebar.** The index already works at block level and
every hit carries a location a human would recognise. The bridge still returns
document rows, so the surface cannot yet say *where* in the file.

## Later

**Panels on opposite sides.** The layer rules already know which panels could sit
opposite each other; the animation and the visual judgment are not made. This is
a design decision more than an engineering one.

**Typography preview inside the settings panel.** Adjusting a measure or a
baseline grid while looking at real text, rather than at a number.

**Rail virtualisation under a hundred thousand files.** The windowing exists; the
question is whether the directory reconciliation stays honest at that size.

## Under consideration

**Binary size.** 22.08MB in release on Linux, with `strip`, `lto` and
`codegen-units = 1` already on. `panic = "abort"` and dependency pruning (605
crates) are unexplored. `opt-level = "z"` is **not** planned: it trades away the
performance work this project has already banked.

**Windows evidence.** Every number in this repository comes from Linux. WebView2
in a real window, IME behaviour, the installer path, a high-refresh display,
input-to-paint end to end — none of it has been measured on the platform most
authors will use, and none of it will be claimed until it has.

---

- [README.md](../README.md) — what RefRain is today
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
