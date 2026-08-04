# Architecture

This document tells an agent — or a new contributor — where a problem most
likely lives, how the pieces connect, and which words this project uses for
which concepts.

Everything here is measured from the repository at the commit you are reading.
When a number and the code disagree, the code is right; please fix this file in
the same change.

---

## What RefRain is

A local writing workbench for long-form manuscripts. The author writes in
Markdown; an agent may propose changes; **only a human click merges anything
into the text.**

Four invariants shape most of the design. They are not aspirations — each one
has a gate that fails when it is broken:

| Invariant | What it means in code |
|---|---|
| **No network** | The application process opens no sockets. Gates scan for network APIs. |
| **Only a human merges** | An agent produces *proposals*. Nothing reaches the manuscript without a recorded decision. |
| **Source Backup is never written** | `.refrain-source/` holds the files as they were when the Root was adopted. Read-only, forever. |
| **Delete means the recycle bin** | Nothing is removed from disk outright. |

---

## The shape of the system

```
                    ┌──────────────────────────────┐
                    │  apps/native/src/app.native  │   the surface
                    │  markup: structure + events  │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  apps/native/src/core.ts     │   interface state
                    │  Model · Msg · update · Cmd  │   (restricted subset)
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  apps/native/src/*.zig       │   platform + drawing
                    │  events, projections, labels │
                    └──────────────┬───────────────┘
                                   │  one C ABI entry, generated protocol
                    ┌──────────────▼───────────────┐
                    │  apps/native/host            │   the bridge
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  refrain-app                 │   use cases
                    └───┬───────────────────────┬──┘
                        │                       │
          ┌─────────────▼────────┐   ┌──────────▼──────────┐
          │  refrain-store       │   │  refrain-host       │
          │  SQLite, files, PDF  │   │  agents, runs, edges│
          └─────────────┬────────┘   └──────────┬──────────┘
                        │                       │
                    ┌───▼───────────────────────▼───┐
                    │  refrain-core                 │   the domain
                    │  no internal dependencies     │
                    └───────────────────────────────┘
```

Dependencies point **downward only**. `refrain-core` depends on no other crate
in this workspace, which is what makes it the place to put a rule you want to
be true everywhere.

The four layers above `refrain-app` each hold one thing and refuse the rest;
[AGENTS.md](AGENTS.md) states the table that `native check . --strict` enforces.
The single rule worth repeating here: **the manuscript lives in Rust**. Zig draws
a borrowed projection, and the TypeScript core holds a revision number — neither
holds the bytes.

### Scale, measured

| Crate | Modules | Lines | Owns |
|---|---:|---:|---|
| `refrain-core` | 30 | 10,950 | The domain: manuscripts, blocks, document formats, line breaking, the agent protocol, ranking |
| `refrain-store` | 23 | 8,545 | SQLite, the file catalogue, ingestion, search indexes, action history, the Config file |
| `refrain-host` | 6 | 4,301 | Agents, Runs, orchestration edges, staging, harness adapters |
| `refrain-app` | 12 | 4,195 | Use cases that need more than one of the above, and the one `Application` that holds them |
| `apps/native/host` | 6 | 1,269 | The C ABI dispatch: one entry, generated protocol |
| `apps/native/src` | 12 | 2,691 | Native core (TypeScript), markup, Zig bindings and drawing |

The whole surface is 2,691 hand-written lines. The Tauri/Solid surface it
replaced was 27,175 (22,642 frontend + 4,533 bridge), and every product rule
survived the move because the rules were never in the surface: they live in
`refrain-core` and `refrain-app`, which grew by consolidation, not by rewriting.

---

## Where to look when something is wrong

This table is the fastest path from a symptom to a module.

| Symptom | Start here |
|---|---|
| Text renders wrong, cursor jumps, selection breaks | `refrain-core/src/native_document.rs` — the one document state machine |
| A line breaks in the wrong place | `refrain-core/src/typeset.rs` — the CLREQ 禁则 authority |
| A shortcut does nothing | `apps/native/app.zon` declares it, `core.ts::commandMsg` maps it |
| A block's boundary is wrong | `refrain-core/src/manuscript/` — the byte scanner is the only authority |
| Search returns nothing, or the wrong order | `refrain-store/src/project/search.rs`, `refrain-core/src/search_rank.rs` |
| A file did not save, or saved to the wrong place | `refrain-store/src/atomic.rs`, `root.rs` |
| An agent's reply was rejected | `refrain-core/src/agent_protocol.rs` — the parser and its error codes |
| A request carried the wrong context | `refrain-core/src/context_compiler.rs` |
| A Run started too early, or not at all | `refrain-host/src/host.rs` — `LaunchRun` and the edge constraints |
| A proposal could not be applied | `refrain-app/src/decide.rs`, `refrain-core/src/manuscript/review.rs` |
| Orchestration state was lost | `refrain-app/src/journal.rs` — the entity/row translation |
| A colour is wrong, or a theme looks flat | `apps/native/src/generated/themes.zig` — generated from four anchors per theme |
| A corner is the wrong shape | `apps/native/src/corners.zig` — the five scales and their G-continuity |

---

## How a change reaches the manuscript

The whole product is this sequence. Every step is refusable, and every refusal
is named.

1. **Author selects scopes** and writes a request.
2. **`context_compiler::compile`** freezes a request package: the chosen scopes
   verbatim, the context, the contract, and a digest.
3. **Author clicks dispatch.** `host::AuthorizeDispatch` checks that what was
   clicked is what was staged, mints Runs, and resolves edges to ids.
4. **`host::LaunchRun`** promotes the frozen request into the Run's workspace by
   *rename*. Edge constraints are enforced here: a Run that follows or verifies
   another may not start before that other is terminal.
5. **The producer runs** and writes `result.md`.
6. **`app::collect_attempt`** parses the artifact against the **frozen** request
   — never against the artifact's own claims — and turns replacements into
   proposals.
7. **Author decides** each proposal. `app::decide` records the verdict.
8. **Only then** does text change.

The freezing in step 2 is what makes step 6 honest: if the author edited a scope
after dispatching, the proposal fails loudly rather than being applied to text
the agent never saw.

---

## Orchestration edges

A Task may have several Runs. An edge says how one Run relates to another.

| Edge | Meaning | Enforced by |
|---|---|---|
| `Alternates` | Same question, independent answers | Imposes **no** order. Independence comes from the request being frozen before any peer produced anything. |
| `Follows` | This Run needs the upstream's artifact | May not launch until the upstream is terminal |
| `Verifies` | This Run reads another's work and reports | May not launch until the subject is terminal; **may not propose edits** — an artifact with replacements is refused whole |

`RunEdge` carries positions (the author points at "the second one"); `ResolvedEdge`
carries ids, bound at authorization because that is when ids exist. Both survive
a crash: the edge is part of the `Run` entity that the journal writes.

---

## One authority per fact

Each of these exists exactly once. A second copy is a defect, not a convenience.

| Fact | Sole authority | What that forbids |
|---|---|---|
| Manuscript bytes, selection, composition, undo | `DocumentSurface` — three operations: `open`, `apply`, `project` | A second document state machine. One was written and rejected in step 2 for exactly this reason; selection, word boundaries, revision and viewport are its implementation details, not a public surface |
| Which output a project input produces | `ProjectOutput::into_opened` / `into_imported` | Rebuilding the mismatch error behind a catch-all arm at each call site, which also hides a new variant from review |
| Line breaking | `refrain_core::typeset` | A second set of rules. The SDK breaks only at space and tab (`isTextBreakByte`), which no Chinese paragraph contains, so this is ours by necessity |
| Settings | `ConfigStore::apply`, reached through `Application::apply_config` | A string key/value update path. The change set is an exhaustive enum |
| Theme colours | The `THEMES` table in `scripts/generate-themes.ts` | A hand-kept copy. Four anchors per theme; everything else derives |
| Corner geometry | `apps/native/src/corners.zig` | A bare radius number anywhere else |
| Protocol layout | `apps/native/protocol/host.json` | A hand-edited offset in any generated file |

### Persisted state is discarded when it cannot be trusted

Undo history is keyed by `content_digest`. When a file changed outside RefRain,
the stored head no longer describes those bytes, so the history is dropped
rather than replayed onto text it was not written against.

### The manuscript never crosses as data

Text does not travel as JSON, as `number[]`, or through the 16 KiB response
channel. The response lends a pointer into Rust memory with the projection's
lifetime. Startup compares the schema fingerprint and refuses to run on a
mismatch rather than continuing with drift.

---

## Glossary

Use these words. SPEC §2 requires one word per concept, and
`verify:one-word-per-concept` enforces it inside each concept's own modules.

### The manuscript

| Term | Meaning |
|---|---|
| **Root** | A folder or single file the author adopted. The unit of "a project". |
| **Source Backup** | `.refrain-source/`. The files as they were at adoption. Never written. |
| **Document** | One text file the author is writing — Markdown prose or a plain-text format (code, markup, configuration). The file on disk is the only original. |
| **DocumentFormat** | What a document's bytes are: Markdown or one of the plain-text formats. Decided once from the extension; it picks the block scan, the index preprocessing and the highlighting grammar. |
| **Block** | One structural unit of a document — a paragraph, heading, list, table, fence. Boundaries come from a byte-level scanner; that scanner is the sole authority. |
| **Ordinal** | A block's position within its document. What an agent quotes to fetch it. |
| **Revision** | A document's version counter. A proposal names the revision it was written against. |

### Search

| Term | Meaning |
|---|---|
| **SearchableBlock** | A block as `refrain-core` sees it: borrowed from the source text |
| **IndexedBlock** | A block as `refrain-store` returns it: owned, carries bm25 |
| **DisclosedBlock** | A block as the agent receives it: owned, carries a human-readable location |
| **SearchHit** | A hit handed to the UI |
| **ScoredHit** | A hit mid-ranking, borrowing from the index |
| **Precision** | `Exact` (the author remembers the characters) or `Loose` (only the sense). Exact falls back to Loose when it finds nothing. |

### Agents

| Term | Meaning |
|---|---|
| **Harness** | A local executable that runs an agent. Discovered on this machine; never a remote service. |
| **Task** | One question the author asked, with its Runs. |
| **Run** | One attempt by one agent against one frozen request. |
| **RunEdge** / **ResolvedEdge** | How one Run relates to another — by position, then by id |
| **Dispatch package** | The frozen bytes: request, context, contract, digest |
| **Material** | A reference document the author ticked for this round. Enters the context picker, never the manuscript order. |
| **MaterialListing** | What travels in a request: path, title, headings, an excerpt, size, digest, disclosure. **Not the text.** |
| **Disclosure** | What the author permits for one material: `OutlineOnly`, `Retrievable`, or `Full`. In Chinese UI text: 范围. |
| **Artifact** | What a producer writes: one `<agent-result>` element |
| **Proposal** | A replacement that still matches the frozen text, awaiting a human decision |
| **Review Slice** | One reviewable piece of a proposal. Its ordinal counts slices within a proposal — **not** blocks within a document. Same word, different scope; never compare them. |
| **Verdict Ledger** | The record of every decision: accepted, accepted-with-edits, or sent back |

---

## The contract, and why it is generated

`docs/SKILL.md` is **generated** from
`refrain_core::agent_protocol::skill_doc()`. Do not edit it by hand:

```sh
cargo run -p refrain-core --example generate_skill_doc -- docs/SKILL.md
```

`verify:skill-doc-current` fails when it drifts. This is not ceremony — a
hand-kept copy once taught agents to write `version="1"` while the parser
required `"2"`, so every agent that followed the documentation was rejected.

The contract ships in three tiers, chosen per round. The enum is
`ContractMode` in `refrain-core/src/context_compiler.rs`; the parser in
`agent_protocol.rs` stays the only authority, so a tier changes what a round
carries, never the protocol itself:

| Tier | Content |
|---|---|
| `Short` | The reply shape, the scope rules, how to reach a material. The default, and what a channel without a session carries every round. |
| `Full` | The whole generated protocol document. A harness's first round. |
| `Pointer` | One line, for later rounds on a harness that already holds the full text |

**A guard on the contract belongs on the tier that is actually delivered.** A
test asserting that `Full` explains something reads like coverage while agents
only ever receive `Short`.

---

## Technology

| | |
|---|---|
| **Language** | [Rust](https://rust-lang.org) for the domain; [Zig](https://ziglang.org) for platform and drawing; a restricted [TypeScript](https://www.typescriptlang.org) subset for interface state |
| **Application shell** | [Native SDK](https://native-sdk.dev) — native rendering, no WebView, no JavaScript runtime in the shipped binary |
| **Surface** | `.native` markup compiled against the model contract; [Biome](https://biomejs.dev) formats the TypeScript |
| **Build tooling** | [ScriptC](https://github.com/vercel-labs/scriptc) compiles the tier A gates and release scripts to native binaries; [Bun](https://bun.sh) runs the rest. Build-time only — neither ships. |
| **Storage** | [SQLite](https://sqlite.org) through [rusqlite](https://github.com/rusqlite/rusqlite), FTS5 `unicode61`, and an application-level bigram tokeniser |
| **Hashing** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) |
| **Ids** | [UUID](https://github.com/uuid-rs/uuid), v7 |
| **Serialisation** | [Serde](https://serde.rs); the cross-boundary protocol is generated from one schema into Rust, TypeScript, Zig and a C header |
| **Scanning** | [memchr](https://github.com/BurntSushi/memchr) |
| **Errors** | [thiserror](https://github.com/dtolnay/thiserror) |
| **Line breaking** | `refrain_core::typeset` — see "Why RefRain breaks its own lines" |
| **Imported sources** | An imported PDF is rendered for reading only; RefRain never writes back to it |

### Why RefRain breaks its own lines

The browser can wrap text. RefRain wraps it instead, because the two things it
will not do are exactly what CJK typesetting needs: compress a full-width
punctuation mark at the end of a line, and hang one in the margin.

`packages/typeset` is pure arithmetic — zero dependencies, zero DOM, a string
and a preset in, numbers out. The editor paints those breaks with empty block
elements, so **not one byte enters the text**: a caret offset is still a byte
offset. Two presets, because the rules genuinely conflict — Simplified Chinese
compresses that mark by half an em (GB/T 15834 §5.1.10) where Japanese keeps
the space and hangs the mark instead (JLREQ §3.1.9).

The breaker is greedy, which measurement supports rather than excuses: Chinese
breaks almost anywhere, so greedy already matches the whole-paragraph optimum
while a dynamic program costs 960× more for nothing. The optimiser runs only on
paragraphs holding a long unbreakable run — a Latin word, a URL, inline code.

Computing breaks ourselves also makes them identical on every platform, which
browser wrapping does not guarantee. `verify:layout-parity` freezes them into a
fingerprint and recomputes it on Linux, Windows and macOS; its reverse criterion
requires that switching the in-house rules off changes the result, or the gate
would be measuring the browser instead of this code.

### Why the editor renders tables as aligned text, not as a table

A GFM table could become a real `<table>`. It would look better: cells wrap
inside their own column, so a wide table never overflows the measure. RefRain
does not do this, and the reason is a second coordinate system.

The editor holds one invariant above the others: **a caret offset is a byte
offset**. Everything downstream depends on it — the change ledger stores byte
ranges, the line breaker walks a character array, `locateOffset` counts text
node lengths. A real table replaces that single axis with "row 2, cell 3":

- A caret would need translation between table coordinates and byte offsets.
- A selection across two cells is **discontinuous** in the source, because it
  steps over a `|`.
- The change ledger and the line breaker would both need new range types.

Instead each cell gets an inline-block shell, and cells in one column share a
`min-width`. **No byte is added.** The source text enters the DOM unchanged and
the columns still line up. The cost is that a table wider than the measure
scrolls horizontally, and that columns shift while the author types and settle
when they stop.

Two measurements shaped the implementation, and neither was visible to unit
tests:

- The delimiter row does not **contribute** a column width — the length of
  `|---|` is whatever the author happened to type — but it must **receive** one.
  Treating those as one fact left the delimiter row's four segments bunched at
  24px each while the rows above and below were correct.
- Column width is measured on the **untrimmed** cell. The spaces in `| 概念 |`
  really do occupy the DOM. Trimming first produced identical `min-width` values
  on every row and columns that were still 80px against 96px apart on screen.

### 图与 PDF 阅读：裁定随实现一起等待

步骤 10 之前这里有两节裁定——为什么用 nomnoml 而不是 Mermaid、为什么导入的
PDF 只读不回写。两条依赖（nomnoml、pdf.js）都随旧 DOM 前端一起删除，而 Native
侧的图与多格式阅读属于步骤 5 尚未完成的部分。

**结论仍然成立、论证需要重做**：PDF 只读不回写是产品裁定（`.refrain-source/`
永不写入），与渲染器是谁无关；图的选型判据则要换成原生渲染成本，而不是
浏览器 bundle 体积。等 Native 侧真正接上它们时，在这里重写论证并附实测。

原始论证与当时的 gzip 读数保存在 `roadmap-pre-native-2026-08-03.md`。

### Why bigram, not trigram or a tokeniser

Measured on 22,410 real files (252MB), not chosen from documentation:

- **FTS5 `trigram` was rejected** on two independent grounds: it indexes only
  tokens of three characters or more, so a two-character Chinese word — the most
  common query shape — returns **zero**; and `bm25()` returns `-0.0000` for every
  row because trigram keeps no column-size statistics, so ranking is dead.
- **jieba + a second index was rejected**: an author's invented names are not in
  any dictionary, and a second index store introduces a new failure class
  ("the document changed, the index did not").
- **`unicode61` + application-level bigram** was adopted. Single characters stay
  as their own tokens, or searching for one character returns nothing. Index
  inflation is 1.96×.
- **Terms are joined with `AND`**, against the unanimous advice of the tutorials.
  `OR` returned 500 rows of noise for a word that does not exist; `NEAR` returned
  **zero** for a phrase that does. `AND` cut noise 500 → 21, lost no true answer,
  and ran 6.7× faster.

---

## Gates

`bun run gate` runs every gate script on disk; `verify:gates-run` compares the
two lists and fails when a script exists that nothing invokes. The count is
deliberately not written here — a number in prose has no gate behind it and
drifts. Run the command to see it.

Gates that need a browser are held back into `bun run evidence:headless`, so a
green `gate` run is not the whole story. The Rust checks are **not** among
either and must be run separately:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
bun run gate
```

All four, every time. A defect where a doc comment attached to the wrong
function was caught only by clippy while the gate was fully green.

A gate here is expected to be **injection-verified**: break the thing it guards,
watch it go red, restore, watch it go green. A gate that has never been seen to
fail is a gate that has proven nothing — see [CONTRIBUTING.md](CONTRIBUTING.md).

### A headless gate can fail for a reason that is not the code

Some machines run a headless Chromium that draws shapes but **not glyphs**.
Measured in one page: `fillRect` gives 400 opaque pixels, `fillText("A")` gives
**0**, and `measureText` returns a width of **0**. Every gate that measures text
geometry then fails for a reason unrelated to the product, while the diagram and
settings gates still pass because they assert shapes and structure. Supplying a
real font does not help — the fonts load and the widths stay zero.

Before treating such a red as a defect, run the same gate on the base commit
with no local changes; identical failure text is the evidence. Facts that must
hold regardless — that the PDF renderer passes no remote URL, that a table adds
no byte — are therefore also asserted by tests that need no browser.

---

## Related documents

- [README.md](../README.md) — what RefRain is, and how to install it
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
- [ROADMAP.md](ROADMAP.md) — what is planned (written in Chinese)
- [AGENTS.md](AGENTS.md) — working discipline for agents in this repository
- [SKILL.md](SKILL.md) — the agent protocol (generated)
- [LICENSE](../LICENSE) — MPL 2.0
