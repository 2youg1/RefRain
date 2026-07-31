<div align="center">

# RefRain

**A local writing workbench for long manuscripts, where an agent may propose and only you may merge.**

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)

</div>

---

RefRain is for people writing something long — a novel, a thesis, a report that
took two years. Your Markdown files stay yours: the `.md` on disk is the only
original, and RefRain never becomes the thing you have to export from.

Agents can read your materials, search your manuscript, and propose changes.
Every proposal waits for you. Nothing enters your text without a click.

The application makes no network requests.

## Features

**Writing**

- The whole manuscript is one editing surface — selection crosses paragraphs
- A hundred thousand blocks, with about sixty mounted at any moment
- Frame scheduling synchronised to your display's refresh rate
- IME composition is never interrupted; saving waits for `compositionend`
- Three font slots (Latin, Chinese, Japanese) with shared-Han priority
- Full typographic control: weight, letter and word spacing, measure, indent,
  paragraph spacing, alignment, baseline grid, display scale
- Language presets for Chinese, Japanese and English, plus your own
- Punctuation width suggestions, empty-paragraph cleanup, three-state inline
  formatting that never leaves `****` behind
- Headings, quotes and lists as three-state commands
- Highlights and annotations that ask to be re-anchored rather than guessing
- When a save fails, you get steps you can act on

**Working with agents**

- Local harnesses are discovered and connected without you knowing a path
- Dispatch a work order straight from an annotation
- The request bytes are frozen as the contract: if you edited a scope after
  dispatching, the proposal fails honestly instead of landing on text the agent
  never read
- Verdict Ledger — accept, accept with edits, or send back, sentence by sentence
- Multiple agents in one round: independent alternates, sequential follows, or
  one agent verifying another's work
- Materials travel as listings, not as text. Three 100KB references cost about
  1,250 bytes instead of 300,000; the agent fetches what it decides it needs

**Boundaries**

- No network from the application process
- Only a human click merges text
- Source Backup is never written
- Deleting moves to the recycle bin

**Scale** — measured on this machine, not estimated

- 1GB Markdown opens (7.2 million blocks)
- 11.4MB / 100k-block manuscript, open to JSON: p95 68ms
- 100MB PDF import parses in 195ms
- 100k-file project directory, warm: p95 404ms

## Install

Windows installer (NSIS), built with Tauri. A native release-policy program,
compiled from TypeScript with ScriptC, verifies the exact installer set before
upload. WebView2 is installed by the bootstrapper if it is missing.

Building from source requires the Rust toolchain and Bun:

```sh
bun install
bun x tauri build
```

Before committing, all four checks:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
bun run gate
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — modules, glossary, and where a problem
  most likely lives
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
- [ROADMAP.md](ROADMAP.md) — what is planned
- [AGENTS.md](AGENTS.md) — working discipline for agents in this repository
- [SKILL.md](SKILL.md) — the agent protocol (generated from the parser)

## Other

Built with [Tauri](https://tauri.app), [SolidJS](https://solidjs.com) and
[Rust](https://rust-lang.org). Storage is SQLite through
[rusqlite](https://github.com/rusqlite/rusqlite), with FTS5 and an
application-level bigram tokeniser — the reasoning, and the measurements behind
rejecting the usual advice, are in
[ARCHITECTURE.md](ARCHITECTURE.md#why-bigram-not-trigram-or-a-tokeniser).

Licensed under [MPL 2.0](LICENSE).

## Acknowledgements

**[Shiki](https://shiki.style)** (MIT) for syntax highlighting. RefRain
registers its entry points precisely so that highlighting never reaches the
network — the library made that possible rather than fighting it.

The bundled typefaces, all under the
[SIL Open Font License 1.1](https://openfontlicense.org):

- **[Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)** —
  20,976 Han characters plus kana, the reason a Chinese manuscript shows no tofu
- **[Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New)**
  — 6,682 Han characters, for Japanese text
- **[Antic Didone](https://fonts.google.com/specimen/Antic+Didone)**
- **[Jost](https://indestructibletype.com/Jost.html)**
- **[Courier Prime](https://quoteunquoteapps.com/courierprime/)**

Full third-party terms are in [LICENSE-THIRD-PARTY](LICENSE-THIRD-PARTY).
