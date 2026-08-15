<div align="center">

# RefRain

**A local writing workbench for long manuscripts, where an agent may propose and only you may merge.**

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
the way you expect. A bounded 96-block projection is mounted at any moment out
of a possible hundred thousand, and frame scheduling follows your display's
refresh rate.

For CJK authors specifically: IME composition is never interrupted, and saving
waits for `compositionend`. Three typefaces are bundled and registered with the
renderer — Noto Sans SC for the manuscript, Antic Didone for Latin, Zen Kaku
Gothic New for Japanese. One honest limit: the Native SDK's typography has a
global text face and a global mono face and nothing per-script yet, so the
manuscript is drawn in Noto Sans SC, which covers Han and kana in one face.

Typography settings persist per author and take effect as you move the sliders:
text size, line height and measure re-project the manuscript live. The wider
set (indent, alignment, baseline grid and friends) is stored and carried, but
the renderer does not consume it yet — a known boundary, stated here rather
than silently dropped.

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

Measured, not estimated — and each row says which platform measured it, because
the two disagree where the filesystem does the work:

| | | |
|---|---|---|
| 1GB Markdown | opens — 7.2 million blocks | Linux |
| 11.4MB manuscript, 100k blocks | open to JSON, p95 68ms | Linux |
| 100MB PDF import | parses in 195ms | Linux |
| 100k-file project directory | warm refresh, p95 404ms | Linux |
| 100k-file project directory | warm refresh, p95 **1032ms**; open one page, p95 810ms | **Windows — the release platform** |

The last row is the one to read before judging the others: a warm refresh is a
metadata walk of every file, and NTFS charges several times what ext4 charges
for it. `crates/refrain-store/tests/project_performance.rs` therefore holds a
budget per platform, each carrying the reading that set it.

## How the code is organised

Read this section before you open an editor — human or agent.

RefRain is a stack of six layers. Each layer holds one kind of thing and
refuses the rest; a layer may depend only on the layers below it.

| Layer | Crate / directory | Holds |
|---|---|---|
| L0 domain | `crates/refrain-core` | Every product rule. Depends on nothing in the workspace. |
| L1 persistence | `crates/refrain-store` | Both databases, every disk write, the Config file, trash |
| L2 orchestration | `crates/refrain-host` | Task/Run state, workspaces, process launching, harness adapters |
| L3 use cases | `crates/refrain-app` | The flows that need more than one layer below |
| L4 bridge | `apps/native/host` | The C ABI between Rust and the surface |
| L5 surface | `apps/native/src` | Markup, interface state (a restricted TypeScript subset), platform events and drawing (Zig) |

Five rules decide where any code belongs:

1. **Deep modules.** A module earns its existence by owning an invariant.
2. **One authority per fact.** A second copy is a defect, not a convenience.
3. **Layers point down.** Never up, never sideways.
4. **Links are few and named.** Each seam has a schema and a gate.
5. **A feature is a module plus its wiring.** Never logic inside a router's
   match arms, and never a second authority beside an old one.

[ARCHITECTURE.md](docs/ARCHITECTURE.md) enumerates what these rules mean
today: the function matrix (which module owns which function at which layer),
the module inventory, the wiring graph, the glossary, and a symptom-to-module
table for when something is wrong.

## Changing the code safely

**Do not mess it up.** Every new feature starts in
[ARCHITECTURE.md](docs/ARCHITECTURE.md), not in a source file. Find the module,
fix its layer, its event flow, and its neighbours. If the feature is not in the
document, add it there first and land the code and the document update in the
same commit. The full discipline is in [AGENTS.md](docs/AGENTS.md) — if you
cannot follow it, do not add a line of code.

**Mess it up less.** Search the repository before you write anything: the rule,
the guard, or the derivation you need usually exists already. Match the
surrounding code. Write one test that can fail, not five that restate the
implementation.

**After you messed it up.** Run the full verification chain (below) and read
the first red, not the last. A red gate can be the environment rather than your
change — run the same gate on the base commit to tell them apart. The
symptom-to-module table in [ARCHITECTURE.md](docs/ARCHITECTURE.md) maps the
failure to the module that owns it; fix the one authority, do not add a second
one beside it.

## Install

Releases are published on
[GitHub](https://github.com/kaile9/RefRain/releases). The current release is
v0.3.1 — the native surface with a Windows client, and a manuscript window
that a wheel can bring home from either end.

Most measurements in this repository come from Linux, and nothing is claimed
for a platform until it has been measured there. The exception is the Windows
build itself: it compiles and passes the full test suite on real Windows
hardware. The Windows and macOS input-method paths are written but not yet
signed off.

### Building from source

Requires the Rust toolchain, [Bun](https://bun.sh), and Node.js ≥ 22.15 for the
Native toolchain. On Windows, add the GNU target (`rustup target add
x86_64-pc-windows-gnu`) and keep a `dlltool` on `PATH` — CI uses Zig's. The
RuntimeObject import is bound to `combase.dll`, the library that really exports
it; the forwarder DLL of the same name family is absent on some trimmed Windows
installs.

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
- [AGENTS.md](docs/AGENTS.md) — working discipline for agents in this repository
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — how to propose a change
- [SKILL.md](docs/SKILL.md) — the agent protocol, generated from the parser

## Technology

| | |
|---|---|
| **Core** | [Rust](https://rust-lang.org) — the domain, storage, and agent orchestration |
| **Application shell** | [Native SDK](https://native-sdk.dev) — native rendering. No WebView, and no JavaScript runtime in the shipped binary. |
| **Surface** | `.native` markup, a restricted [TypeScript](https://www.typescriptlang.org) subset for interface state, and [Zig](https://ziglang.org) for platform events and drawing |
| **Storage** | [SQLite](https://sqlite.org) via [rusqlite](https://github.com/rusqlite/rusqlite); FTS5 `unicode61` with an application-level bigram tokeniser |
| **Identity** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) digests, [UUID](https://github.com/uuid-rs/uuid) v7 |
| **Bindings** | [Serde](https://serde.rs) and [Specta](https://github.com/specta-rs/specta), which generates the TypeScript types |
| **Line breaking** | `refrain_core::typeset` — RefRain's own, because no engine breaks Chinese correctly (see [ARCHITECTURE.md](docs/ARCHITECTURE.md)) |
| **Highlighting** | The Native SDK's own `code` widget — 17 grammars compiled into the binary, so nothing is loaded at runtime and nothing reaches the network |
| **Imported sources** | Text is extracted by `lopdf` in Rust — no renderer, no browser engine. Each page's text carries a `<!-- p.N -->` anchor, so a quotation can name the page it came from and a reader can return to the original. |
| **Build tooling** | [ScriptC](https://github.com/vercel-labs/scriptc) compiles the tier A gates and the release program to native binaries; [Bun](https://bun.sh) and [Node.js](https://nodejs.org) run the rest. Build-time only — nothing of them ships. |

## Licence

[MPL 2.0](LICENSE).

## Acknowledgements

The bundled typefaces, all under the
[SIL Open Font License 1.1](https://openfontlicense.org):

- **[Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)** — 20,976 Han characters plus kana, the manuscript face and the reason a Chinese manuscript shows no tofu
- **[Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New)** — 6,682 Han characters, the Japanese slot
- **[Antic Didone](https://fonts.google.com/specimen/Antic+Didone)** — the Latin serif slot

Full third-party terms are in [LICENSE-THIRD-PARTY](LICENSE-THIRD-PARTY).
