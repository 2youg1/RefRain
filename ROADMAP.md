# Roadmap

Directions, not dates. Each item below has evidence behind it — either
measurements that showed it is worth doing, or a gap found while doing something
else. Items are removed when they ship, or when measurement kills them.

## Next

**Markdown preview viewport.** A new `packages/preview`. The security surface is
part of the design, not a setting: sandboxed, no scripts, no network. This is a
new capability rather than a fix, which is why it is not further along.

**Syntax highlighting in the preview.** Shiki, registered through `shiki/core`
with exact entry points so that nothing reaches the network. Measured: the pure
JavaScript engine covering six languages is 94KB gzipped, against 297KB for the
WASM build covering three — the smaller, network-free path is also the more
capable one here.

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

**ScriptC.** Compiling parts of this project ahead of time is an open question,
and the measurements so far are mixed rather than negative. On this machine with
ScriptC 0.0.17: `shell/strata.ts` is 100% statically compilable, `quarters.ts`
88%, `projection.ts` 77% — the pure logic modules compile well. Two things are
in the way of the obvious use. The build scripts call Bun-specific APIs
(`Bun.file`), which ScriptC does not recognise. And the output is a native
executable, while the frontend runs inside WebView2 and needs loadable
JavaScript — so it is not a drop-in for the web build.

Worth noting for scope: **Bun contributes no bytes to the installer.** It
appears only in `beforeDevCommand` and `beforeBuildCommand`; the bundle target
is NSIS. Any lightness argument has to look elsewhere.

**Binary size.** 17.34MB in release, with `strip`, `lto` and
`codegen-units = 1` already on. `panic = "abort"` and dependency pruning (571
crates) are unexplored. `opt-level = "z"` is **not** planned: it trades away the
performance work this project has already banked.

**Windows evidence.** Every number in this repository comes from Linux. WebView2
in a real window, IME behaviour, the installer path, a high-refresh display,
input-to-paint end to end — none of it has been measured on the platform most
authors will use, and none of it will be claimed until it has.

---

- [README.md](README.md) — what RefRain is today
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
