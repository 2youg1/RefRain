<div align="center">

# RefRain

**A local writing workbench for long manuscripts, where an agent may propose and only you may merge.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![Download](https://img.shields.io/github/v/release/kaile9/RefRain?label=Download&color=blue)](https://github.com/kaile9/RefRain/releases/latest)

</div>

---

## The problem

An agent that edits your manuscript directly is fast and unaccountable. You end
up reading the diff to find out what happened to your own book, and the version
that made sense is somewhere behind you.

An agent that only chats is accountable and useless. You copy text out, paste it
back, and lose the thread every time.

RefRain takes the third position: **the agent proposes, you decide, and the
record of who decided what is part of the document.**

## How it works

You select the passages an agent may see. RefRain freezes those exact bytes into
a request — the scopes verbatim, the context, the contract, and a digest — and
only then dispatches it.

The agent replies with replacements. RefRain checks each one against the
**frozen** request rather than against the agent's own claims, so a proposal
that no longer matches your text fails loudly instead of landing on a paragraph
the agent never read.

You accept, accept with edits, or send it back. That verdict is recorded. Only
then does your text change.

## Four things this software will not do

Each one has a gate that fails the build when it is broken:

| | |
|---|---|
| **It makes no network requests** | The application process opens no sockets. Your manuscript is on your disk and stays there. |
| **It never merges without your click** | An agent produces proposals. Nothing reaches the text without a recorded decision. |
| **It never writes your Source Backup** | `.refrain-source/` holds your files as they were when you adopted the folder. Read-only, permanently. |
| **It never deletes outright** | Removal goes to the recycle bin. |

## What you get

### Writing

The whole manuscript is one editing surface, so a selection crosses paragraphs
the way you expect. About sixty blocks are mounted at any moment out of a
possible hundred thousand, and frame scheduling follows your display's refresh
rate.

For CJK authors specifically: IME composition is never interrupted, saving waits
for `compositionend`, and three font slots (Latin, Chinese, Japanese) resolve
shared Han characters by priority rather than by accident.

Typography is under your control — weight, letter and word spacing, measure,
indent, paragraph spacing, alignment, baseline grid, display scale — with
presets for Chinese, Japanese and English, and room for your own. Fenced code is
syntax-highlighted across thirty-four languages and six palettes, all embedded
at build time so that highlighting never reaches the network.

Editing is reversible. Ctrl+Z undoes the last step, and a history panel beside
the manuscript can roll back to any earlier step — the record survives restarts.
An agent's merged proposal is reversed differently: from the mailbox, as a
countermanding verdict that is itself recorded, never by erasing the ledger.

Markdown is not the only editable format. LaTeX, TypeScript, Rust, Python, Go,
Lean 4, CSS, HTML, XML, TOML and YAML open, edit and save back byte-for-byte as
plain text — with the embedded highlighter picking the grammar by extension,
and no Markdown machinery touching the source.

Lines are broken by RefRain itself, because no engine breaks Chinese correctly:
the one it replaced could only break at a space or a tab, and a Chinese
paragraph has neither. RefRain applies the CLREQ line-breaking rules — a
full-width punctuation mark is compressed at the end of a line, an unbreakable
unit overflows rather than being cut, and the breaks come out identical on every
platform because the algorithm is one Rust module rather than three browser
engines.

**Where the rewrite stands.** RefRain is moving onto a native rendering path.
The domain — manuscript bytes, block identity, verdicts, orchestration, PDF text
extraction — carried over whole and is covered by tests. The screens are being
rebuilt one at a time, so the features released in v0.2.4 (in-place Markdown
rendering, tables, diagrams, PDF reading, annotations, search results, history)
are **temporarily without a surface**: their rules and dependencies are still
here, and each returns as its native screen lands. Nothing was dropped from the
product; what changed is what draws it.

### Working with agents

Local harnesses are discovered and connected without you knowing a path. One
click installs RefRain's generated protocol into the harness's skill directory
— later rounds then carry a one-line pointer instead of the whole contract.
Each agent works in a persistent workspace of its own, with its identity loaded
from AGENTS.md and a Memo it maintains between rounds. You can dispatch a work
order straight from an annotation.

Several agents can work one round together: independent **alternates** answering
the same question, **follows** that read an upstream result, or one agent that
**verifies** another's work and may report but not propose edits.

Reference documents travel as listings rather than as text. Three 100KB
references cost about 1,250 bytes instead of 300,000, and the agent fetches what
it decides it needs — you are not paying to send an agent a library it will not
open.

Every decision lands in the **Verdict Ledger**: accepted, accepted with edits, or
sent back, sentence by sentence.

### Scale

Measured on the development machine, not estimated:

| | |
|---|---|
| 1GB Markdown | opens — 7.2 million blocks |
| 11.4MB manuscript, 100k blocks | open to JSON, p95 68ms |
| 100MB PDF import | parses in 195ms |
| 100k-file project directory | warm, p95 404ms |

## Install

RefRain has not been released yet. The application builds and runs for
Windows, macOS and Linux from one manifest, but no platform has been through a
real installer run, so nothing is offered for download.

Every measurement in this repository comes from Linux. Nothing will be claimed
for a platform until it has been measured there — in particular, the Windows
and macOS input-method paths are written but not yet signed off on real hardware.

### Building from source

Requires the Rust toolchain and [Bun](https://bun.sh):

```sh
bun install
cd apps/native && ./node_modules/.bin/native build . --yes
```

Before committing, in this order — the order is load-bearing:

```sh
bun install
bun run scriptc:build    # the tier A gates run as compiled binaries
bun run gate             # generates the corpora that the Rust tests read
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
mkdir -p .tmp
TMPDIR="$PWD/.tmp" cargo test --workspace --all-targets
```

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, glossary, and where a problem most likely lives
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — how to propose a change
- [ROADMAP.md](docs/ROADMAP.md) — what is planned (written in Chinese)
- [AGENTS.md](docs/AGENTS.md) — working discipline for agents in this repository
- [SKILL.md](docs/SKILL.md) — the agent protocol, generated from the parser

## Technology

| | |
|---|---|
| **Core** | [Rust](https://rust-lang.org) — the domain, storage, and agent orchestration |
| **Application shell** | [Native SDK](https://native-sdk.dev) — native rendering. No WebView, and no JavaScript runtime in the shipped binary. |
| **Surface** | `.native` markup, a restricted [TypeScript](https://www.typescriptlang.org) subset for interface state, and [Zig](https://ziglang.org) for platform events and drawing |
| **Editor kernel** | Framework-free direct DOM; Rust owns the canonical bytes |
| **Storage** | [SQLite](https://sqlite.org) via [rusqlite](https://github.com/rusqlite/rusqlite); FTS5 `unicode61` with an application-level bigram tokeniser |
| **Identity** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) digests, [UUID](https://github.com/uuid-rs/uuid) v7 |
| **Bindings** | [Serde](https://serde.rs) and [Specta](https://github.com/specta-rs/specta), which generates the TypeScript types |
| **Line breaking** | `refrain_core::typeset` — RefRain's own, because no engine breaks Chinese correctly (see below) |
| **Highlighting** | The Native SDK's own `code` widget — 17 grammars compiled into the binary, so nothing is loaded at runtime and nothing reaches the network |
| **Diagrams** | [nomnoml](https://github.com/skanaar/nomnoml) at 26 KB gzipped, with a translator that accepts Mermaid flowchart syntax |
| **Imported sources** | Text is extracted by `lopdf` in Rust — no renderer, no browser engine. Each page's text carries a `<!-- p.N -->` anchor, so a quotation can name the page it came from and a reader can return to the original. |
| **Build tooling** | [ScriptC](https://github.com/vercel-labs/scriptc) compiles the gates and release scripts to native binaries; [Bun](https://bun.sh) runs the rest. Neither ships. |
| **Build and release** | [Bun](https://bun.sh) and [Node.js](https://nodejs.org), build-time only; [ScriptC](https://github.com/vercel-labs/scriptc) compiles the release policy into a native executable |

Why the search index uses bigrams rather than trigrams or a tokeniser — with the
measurements that decided it — is in
[ARCHITECTURE.md](docs/ARCHITECTURE.md#why-bigram-not-trigram-or-a-tokeniser).

## Licence

[MPL 2.0](LICENSE).

## Acknowledgements

The bundled typefaces, all under the
[SIL Open Font License 1.1](https://openfontlicense.org):

- **[Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)** — 20,976 Han characters plus kana, the reason a Chinese manuscript shows no tofu
- **[Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New)** — 6,682 Han characters, for Japanese text
- **[Antic Didone](https://fonts.google.com/specimen/Antic+Didone)**
- **[Jost](https://indestructibletype.com/Jost.html)**
- **[Courier Prime](https://quoteunquoteapps.com/courierprime/)**

Full third-party terms are in [LICENSE-THIRD-PARTY](LICENSE-THIRD-PARTY).
