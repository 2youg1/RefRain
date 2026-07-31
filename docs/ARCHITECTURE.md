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
                    │  apps/desktop/src  (SolidJS) │   the surface
                    └──────────────┬───────────────┘
                                   │  typed commands (specta-generated)
                    ┌──────────────▼───────────────┐
                    │  apps/desktop/src-tauri      │   the bridge
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

### Scale, measured

| Crate | Modules | Lines | Owns |
|---|---:|---:|---|
| `refrain-core` | 27 | 7,862 | The domain: manuscripts, blocks, the agent protocol, ranking |
| `refrain-store` | 25 | 10,009 | SQLite, the file catalogue, ingestion, search indexes |
| `refrain-host` | 6 | 3,579 | Agents, Runs, orchestration edges, staging |
| `refrain-app` | 8 | 1,532 | Use cases that need more than one of the above |
| `apps/desktop/src-tauri` | — | 4,169 | The command bridge |
| `apps/desktop/src`, `packages/editor` | — | 12,679 | The surface |

---

## Where to look when something is wrong

This table is the fastest path from a symptom to a module.

| Symptom | Start here |
|---|---|
| Text renders wrong, cursor jumps, selection breaks | `packages/editor/src/virtual-manuscript-view.ts`, `projection.ts` |
| A block's boundary is wrong | `refrain-core/src/manuscript/` — the byte scanner is the only authority |
| Search returns nothing, or the wrong order | `refrain-store/src/project/search.rs`, `refrain-core/src/search_rank.rs` |
| A file did not save, or saved to the wrong place | `refrain-store/src/atomic.rs`, `root.rs` |
| An agent's reply was rejected | `refrain-core/src/agent_protocol.rs` — the parser and its error codes |
| A request carried the wrong context | `refrain-core/src/context_compiler.rs` |
| A Run started too early, or not at all | `refrain-host/src/host.rs` — `LaunchRun` and the edge constraints |
| A proposal could not be applied | `refrain-app/src/decide.rs`, `refrain-core/src/manuscript/review.rs` |
| Orchestration state was lost | `refrain-app/src/journal.rs` — the entity/row translation |
| A panel is in the wrong layer, or the light looks flat | `apps/desktop/src/shell/strata.ts`, `lamp.ts`, `quarters.ts` |

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

## Glossary

Use these words. SPEC §2 requires one word per concept, and
`verify:one-word-per-concept` enforces it inside each concept's own modules.

### The manuscript

| Term | Meaning |
|---|---|
| **Root** | A folder or single file the author adopted. The unit of "a project". |
| **Source Backup** | `.refrain-source/`. The files as they were at adoption. Never written. |
| **Document** | One Markdown file the author is writing. The `.md` on disk is the only original. |
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
| **Language** | [Rust](https://rust-lang.org) |
| **Desktop shell** | [Tauri](https://tauri.app) with [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |
| **Frontend** | [SolidJS](https://solidjs.com), [TypeScript](https://www.typescriptlang.org), [Biome](https://biomejs.dev) |
| **Build tooling** | [Bun](https://bun.sh) and [Node.js](https://nodejs.org); build-time only, not bundled |
| **Release policy** | [ScriptC](https://github.com/vercel-labs/scriptc) compiles `scripts/release-assets.ts` into the native Windows asset validator. When ScriptC cannot compile on a runner, the workflow runs the same script on Bun; both paths were measured to produce a byte-identical manifest. |
| **Storage** | [SQLite](https://sqlite.org) through [rusqlite](https://github.com/rusqlite/rusqlite), FTS5 `unicode61`, and an application-level bigram tokeniser |
| **Hashing** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) |
| **Ids** | [UUID](https://github.com/uuid-rs/uuid), v7 |
| **Serialisation** | [Serde](https://serde.rs); [Specta](https://github.com/specta-rs/specta) generates TypeScript bindings |
| **Scanning** | [memchr](https://github.com/BurntSushi/memchr) |
| **Errors** | [thiserror](https://github.com/dtolnay/thiserror) |
| **Highlighting** | [Shiki](https://shiki.style), with an explicit offline language and theme set |

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

`bun run gate` runs 48 stages over the 42 gate scripts on disk. The Rust checks
are **not** among them and must be run separately:

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

---

## Related documents

- [README.md](../README.md) — what RefRain is, and how to install it
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
- [ROADMAP.md](ROADMAP.md) — what is planned (written in Chinese)
- [AGENTS.md](AGENTS.md) — working discipline for agents in this repository
- [SKILL.md](SKILL.md) — the agent protocol (generated)
- [LICENSE](../LICENSE) — MPL 2.0
