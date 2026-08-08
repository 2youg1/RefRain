# Architecture

This document tells an agent — or a new contributor — what the system is made
of: which functions exist, which layers hold them, which modules own them, and
which named links connect them. Read it top to bottom once; after that, the
matrix and the wiring graph are the two pages to keep open while you work.

Everything here is measured from the repository at the commit you are reading.
When a number and the code disagree, the code is right; please fix this file in
the same change.

---

## What RefRain is

A local writing workbench for long-form manuscripts. The author writes in
Markdown (and a fixed set of plain-text formats); an agent may propose changes;
**only a human click merges anything into the text.**

Four invariants shape most of the design. They are not aspirations — each one
has a gate that fails when it is broken:

| Invariant | What it means in code |
|---|---|
| **No network** | The application process opens no sockets. `verify:no-network` scans for network APIs. |
| **Only a human merges** | An agent produces *proposals*. Nothing reaches the manuscript without a recorded decision in the Verdict Ledger. |
| **Source Backup is never written** | `.refrain-source/` holds the files as they were when the Root was adopted. Read-only, forever. `verify:write-path` scans for a path that leads there. |
| **Delete means the recycle bin** | Nothing is removed from disk outright. `verify:trash-only`. |

---

## The design rule

Five sentences, in order of importance. Everything after this section is the
enumeration of what they mean today.

1. **Deep modules.** A module is deep when its interface is narrow and what it
   hides is wide: `typeset` takes a string and a preset and returns break
   offsets; it hides CLREQ/JLREQ rules, measurement tables, and the greedy
   optimiser. A module earns its existence by owning an invariant or a rule
   that callers would otherwise have to remember. A module with one call site
   and no invariant is a rename, not a module.
2. **One authority per fact.** Every rule, state transition, and stable fact
   exists in exactly one module. A second copy is a defect, not a convenience —
   two copies drift, and nothing reports the drift.
3. **Layers point down.** Domain ← persistence ← orchestration ← use cases ←
   bridge ← surface. A layer may depend only on layers below it. `refrain-core`
   depends on nothing in the workspace, which is what makes it the place to put
   a rule you want to be true everywhere.
4. **Links are few and named.** A link is a seam with a schema and a gate: the
   command space, the two ABI channels, the three traits, the generated
   artifacts. Nothing crosses a layer boundary except through a named link, and
   every link states what *never* crosses it. The manuscript bytes, for
   example, never travel as data — see the wiring graph.
5. **A feature is a module plus its wiring.** New work lands as a deep module
   in the layer that owns its invariant, then a connection through the existing
   links. It does not land as logic inside the router's match arms, and never
   as a second authority beside an old one.

The test shape follows the same decomposition: a **module** is proven by its
own unit and integration tests; a **link** is proven by a gate or a round-trip
test across the seam; a **layer** is proven by a boundary gate
(`verify:core-purity`, `verify:write-path`, `native check --strict`); a
**function** is proven by a use-case test that walks it end to end
(`tests/k3_full_flow.rs`, `tests/edge_end_to_end.rs`, the e2e journals).

### The stage rule

The manuscript is the only stage. Two interaction zones are fixed, and no
third one may appear:

- **The function rail.** Every tool surface — files, review, dispatch,
  mailbox, connections, history, settings — enters from the same side as a
  panel, stacked in depth order. A tool never opens above the text.
- **The editing zone.** Text actions live on the text: the right-click menu
  and the key chords. The mouse stays where the words are. In-place anchors
  (the context menu, proposal dots, the verdict bento) attach to the exact
  line they act on; they are the zone's vocabulary, not floaters.

No new UI floats above the manuscript layer. There are two exemptions and
there will never be a third: the agent-state recovery card (KARA's "you
stopped here"), and the settings surface when the author asks for it
fullscreen. A floating surface outside these two is a defect, not a feature.

The surface is progressive and guided, in this order: a layer appears only
when the task calls for it; each layer shows its own keys on its buttons, so
the menu teaches the chords and the chords replace the mouse; Escape closes
exactly one layer, the innermost first. Guidance is part of the surface, not
a manual beside it.

Three rules make the guidance concrete:

- **The palette lives in the rail as a tree.** The command launcher is not an
  overlay: it opens inside the function rail, arranged as a tree like the
  file tree beside it. Depth discloses progressively, the way a skill's
  SKILL.md does — the summary row first, the detail only when the author
  opens the node. Every feature gets the same treatment: the simple path is
  visible, the full depth is one expansion away, never one window away.
- **Both input paths are first-class.** Every action works with the mouse
  alone, and the pointer never travels far: the target sits in the text the
  author is reading or in the rail beside it. Every action also works from
  the keyboard, and every button prints its chord — the habit forms by
  repetition, never by study. A flow that needs a large mouse movement is a
  defect, and so is a flow that needs a chord the surface never showed.
- **One layer at a time.** Opening a layer never replaces what the author
  was reading; it stacks beside it (rail) or attaches to the line (editing
  zone). Closing returns exactly to the previous state.

---

## The function matrix

Rows are the product's functions. Columns are the layers. A cell names the
module that owns that function at that layer; a dash means the function does
not exist at that layer — and should not.

Status: **●** linked end to end · **◐** the modules exist but a named link is
missing (see *The missing links*) · **○** not landed on the native surface.

| Function | L0 domain `refrain-core` | L1 persistence `refrain-store` | L2 orchestration `refrain-host` | L3 use cases `refrain-app` | L4 bridge `native/host` | L5 surface `native/src` | |
|---|---|---|---|---|---|---|---|
| **F1 · Edit the manuscript** — keystroke to bytes to projection | `manuscript/`, `source_layout`, `document_format` | `atomic`, `project` (commit CAS), `history` | — | `native_document`, `document` | `document.rs` | document Msgs in `core.ts`, `host_bridge`, `app_main` | ● |
| **F2 · Break lines, measure text** | `typeset`, `block_shape`, `text_width`, `inline_span` | — | — | projection in `native_document` | protocol layout | `host_bridge`, `app_main` | ● typography crosses: config → core → typeset → drawing, with slider deltas from settings |
| **F3 · Plain-text formats** — code, LaTeX, markup, config | `document_format`, `source_layout` (Plain), `typeset` code path | round-trip in `project` | — | `native_document` | `document.rs` | `document_language` | ● |
| **F4 · Roots & the catalogue** | `role` | `root`, `project`, `schema`, `files/index` | — | `application` | `project.rs` | `project_request`, `project_view`, `snapshot` | ● |
| **F5 · Search & jump** | `chinese_index`, `searchable_block`, `search_rank`, `inline_span` | `project/search`, `project/catalog` | — | `application` | `project.rs` | search box in `app_main`, `document_jump` | ● cross-document open-then-jump sequenced (M4 landed) |
| **F6 · Settings** | — | `config` | — | `application::apply_config` | `project.rs` | settings screen in `app_main` | ● |
| **F7 · Harnesses & connections** | — | `config` (connections) | `adapters`, `Tier` | `harness` | `project.rs` | connections screen | ● |
| **F8 · Dispatch & edges** | `context_compiler`, `material_listing`, `upstream_work`, `persona` | `materials`, `orchestration` | `host`, `run_edge`, `staging`, `process`, `adapters` | `dispatch`, `scope`, `upstream`, `cancel` | `project.rs` | dispatch screen, `LaunchRun` | ● within one dispatch; relay and verify auto-launch across rounds (2.2, 2.11); the producer runner is unmade (M9) |
| **F9 · Collect, review & decide** | `agent_protocol`, `manuscript/review`, `manuscript/decision` | `ledger`, `history` | Run records in `host` | `collect`, `decide`, `review`, `journal` | `project.rs` | review screen | ● |
| **F10 · The mailbox** | — | `mailbox` (standing rows) | — | `mailbox` (composition) | `project.rs` | mailbox screen | ● |
| **F11 · History & rollback** | `manuscript/persist` | `history` | — | `history`, `RevertTo` in `native_document` | `INPUT_REVERT_TO` | history screen | ● |
| **F12 · Annotations** | — | `annotations` | — | views in `history`, `Annotate` in `application` | `project.rs` | annotations section, anchor dots in `app_main` | ● anchored ranges cross the projection and paint as dots (M5 landed) |
| **F13 · Materials & import** | `material_listing` | `ingest`, `materials` | — | import & disclosure in `application` | `project.rs` | import entries, disclosure menu, draft rows | ● drafts resolve to material or chapter (`CommitMaterialDraft`, M3 landed) |
| **F14 · KARA** | `kara` | `config` (policy) | — | `application::kara_step` | `project.rs` | `veil.zig`, the mode strip and return card, Ctrl+Enter | ● quiet events produced at the facts; the machine drives the veil (M1 landed) |
| **F15 · Width conversion** — full/half-width punctuation | `text_width` | `history` | — | `ConvertWidth` in `application`, `scope` | `project.rs` | context menu | ● |
| **F16 · Themes & corners** | — | `config` (theme) | — | `application::apply_config` | `project.rs` | `generated/themes.zig`, `corners.zig`, `material.zig`, `material_paint.zig`, `workbench_view` | ● themes and materials both land (panel material consumed in v0.3.0) |
| **F17 · Icons** | — | `icons` | — | — | — | — | ○ no consumer above the store (M7) |
| **F18 · Health & the handshake** | `health` | — | — | `native` | `contract.rs`, `document.rs` | handshake in `core.ts` | ● |

Read a ◐ row as the shopping list for the next version: every module named in
it is already tested at its own layer; what is missing is a link, and the link
is named in the register below.

---

## The layers

Dependencies point **downward only**. Each layer holds one kind of thing and
refuses the rest; the refusal is enforced, not requested.

| Layer | Holds | Never holds | Enforced by | Scale (modules / lines) |
|---|---|---|---|---|
| **L0 `refrain-core`** — the domain | Every product rule: manuscript, blocks, formats, line breaking, the agent protocol, ranking, KARA | A database, a filesystem path, a process, a window | `verify:core-purity`, `#![forbid(unsafe_code)]` | 32 / 11,762 |
| **L1 `refrain-store`** — persistence | Both databases, every mutable disk path, the atomic writer, the Root guard, indexes, the Config file, trash | Domain rules, orchestration semantics | `verify:write-path`, `verify:trash-only` | 23 / 8,857 |
| **L2 `refrain-host`** — orchestration | Task/Run/Authorization state, staging, workspaces, process launching, harness adapters | The database (it writes through the `HostJournal` trait); domain rules | INV-12 reviewed; the journal seam | 6 / 4,693 |
| **L3 `refrain-app`** — use cases | The flows that need more than one layer below; the one `Application`; `DocumentSurface` | FFI, raw pointers, platform APIs | `#![forbid(unsafe_code)]` | 16 / 6,629 |
| **L4 `apps/native/host`** — the bridge | The C ABI: one entry, generated layout, session table, bounded replies, the handshake | Product semantics (those are Rust enums below) | `verify:bridge`, the protocol generator's `--check` | 6 / 1,441 |
| **L5 `apps/native/src`** — the surface | Markup & declarations, interface state, platform events, drawing | Manuscript bytes, product rules | `native check . --strict` (the layer table is in [AGENTS.md](AGENTS.md)) | 13 hand-written / 7,147 + tests |

Lines are counted over every source file under the layer's `src/`, hand-written
only — generated files (`generated/protocol.*`, `generated/themes.zig`, 670
lines) are excluded from L5, and L5's four test files (903 lines) are counted
separately. The whole hand-written surface is 7,147 lines plus its tests; the
Tauri/Solid surface it replaced was 27,175, and every product rule survived
the move because the rules were never in the surface.

L5 is itself three strata, each with its own allowance (enforced by
`native check --strict` and NS9001):

- **Declarations** — `app.zon` (shortcuts, menus) and `app.native` (structure
  and event bindings). No logic.
- **Interface state** — `core.ts` and its two helpers, compiled through the
  restricted subset: numbers, strings, `asciiBytes` literals, array tables,
  interface-annotated records. Holds the `Model`, `Msg`, `update`; never holds
  manuscript bytes or a document state machine.
- **Platform & drawing** — the Zig files. Hold events, borrowed projections,
  non-ASCII labels, geometry; never hold a second copy of the text, the
  selection, the composition, or the undo stack.

The single rule worth repeating here: **the manuscript lives in Rust.** Zig
draws a borrowed projection, and the TypeScript core holds a revision number —
neither holds the bytes.

---

## The module inventory

Every module, what it owns, and what proves it. "Tests" names integration
files under the crate's `tests/`; unmarked modules are pinned by their own
in-module test blocks.

### L0 · `refrain-core` — the domain

| Module | Owns | Proven by |
|---|---|---|
| `manuscript/` | The manuscript state machine: `SourceSnapshot`, `TextHead`, `TextAction`, `TextTransition`, undo regions. Sub-modules: `action` (apply an editor action), `align` (anchor-based region segmentation), `decision` (`Verdict`, `DecisionBatch`, `merged_text`), `persist` (the durable action form), `review` (`EditScope`, `Proposal`, `ReviewSlice`, `classify_change`), plus the internal sequence/text/offset types | `tests/manuscript_*`, `action_edits`, `decision_batch`, `review`, `plain_manuscript`, `block_text_*` |
| `source_layout` | Where blocks start and end: the byte scanner (`Markdown` \| `Plain`) and the digest-bound `SourceLayout` | `tests/source_layout`, `block_boundaries`, `block_scan_parity` |
| `block_shape` | What a block is and roughly how tall: `BlockKind` (paragraph / fence / table / heading), width units, hard lines — read off the bytes during the same scan | `tests/block_shape_scan` |
| `searchable_block` | The block's **ordinal** — the handle the agent and the index share | indexed-search tests in store |
| `chinese_index` | The bigram transformation, applied to both index and query sides; `Precision` | store `tests/fts_capability`, `block_search` |
| `search_rank` | Scoring beyond BM25: capped signals (path, block kind, role), a pure function of candidates | in-module |
| `inline_span` | Which bytes inside a block carry inline Markdown markers; stripping them for the index | in-module |
| `document_format` | What a document's bytes are: the exhaustive `DocumentFormat` enum → block scan, extensions, wire codes | exhaustive-match compile errors |
| `typeset` | CJK line breaking: prose path (禁则, compression, mixed spacing, hanging) and code path; two presets (GB/T 15834 vs JLREQ) | in-module; see *Why RefRain breaks its own lines* |
| `text_width` | Display width units; the full/half-width conversion table | in-module |
| `context_compiler` | What crosses to the agent: the frozen dispatch package (cache-stable section order, manifest, three-stated tokens) and the fact-only narration | `tests` in app (`dispatch`, `collect`) |
| `agent_protocol` | The artifact grammar: hand-written scanner, every rejection in `ArtifactErrorCode`, and `skill_doc()` — the source `docs/SKILL.md` is generated from | `verify:docs-current`, `verify:skill-doc-current` |
| `material_listing` | What an agent is told about a material: verbatim outline, excerpt, `Disclosure` | in-module |
| `upstream_work` | The upstream artifact as a section in a downstream request: untruncated, verbatim, sourced, worded per relation | app `tests/upstream` |
| `persona` | An agent's identity in exactly two modes — `Work` / `Cosplay`; the author's bytes pass through untouched | in-module, byte-exact assertions |
| `kara` | The KARA state machine: six states, one transition function, named effects, quiet vs interrupting events | in-module |
| `role` | `DocumentRole`: document / chapter / material | wire-spelling tests |
| `health` | `HealthReport` — the one thing that crosses every layer of the generation chain | in-module |
| `id`, `digest`, `error` | `Id` (UUID v7); BLAKE3 content digests; `RefrainError` / `ErrorCode` — the single authority for error kinds | `verify:docs-current` enumerates `ErrorCode` |

### L1 · `refrain-store` — persistence

| Module | Owns | Proven by |
|---|---|---|
| `schema` | Two transaction domains (`app.db`, per-project `refrain.db`) and the migration ladder: monotonic, one transaction per step, completion mark last | in-module |
| `atomic` | Atomic file replacement: temp-beside-target, fsync, rename; crash checkpoints; residue recovery with an owner marker | `tests/atomic` stops the writer at every checkpoint |
| `root` | Root layout, the Source Backup taken once, and the path guards every write passes through | `tests/project` |
| `project` | `ProjectStore`: adopt, open, create, commit. Commit is compare-and-swap against the `FileStamp` the author last agreed with | `tests/project`, `plain_formats` |
| `project/catalog` | The document catalogue and paging | `project/catalog/tests` |
| `project/search` | FTS5 queries; Exact falls back to Loose | `tests/search*`, `block_search` |
| `config` | The single Config authority: `config.toml`, the `ConfigChange` enum (the whole settings vocabulary), refusal of damaged or newer files | `tests/config` |
| `history` | The persisted Text Action history; hydration depth 64 | `tests/history` |
| `ledger` | The Verdict Ledger: append-only, idempotent recording, verdicts in decision order | via app `tests/countermand` |
| `mailbox` | The arrangement facts: rank, pin, discard — soft delete only | `tests/mailbox` |
| `orchestration` | Row access for Task / Run / Authorization | via app `tests/journal` |
| `annotations` | Highlight/comment rows: stable block identity, exact offsets, the quote | `tests/annotations` |
| `icons` | The icon pipeline: SVG/PNG judged by content, normalised to one content-addressed 256² PNG | `tests/icons` |
| `materials` | Material draft rows (the agent's words, never edited in place) and source preparation | via app `tests/project` |
| `ingest` (+ `html`, `office`, `pdf`) | The six reference formats → plain text, locally, sources never written | `tests/ingest_security` |
| `files/index` | The workspace walk (ripgrep's traversal; the Source Backup never enters) | in-module |
| `application` | `ApplicationStore` — machine-level facts in `app.db` | via app tests |

### L2 · `refrain-host` — orchestration

| Module | Owns | Proven by |
|---|---|---|
| `host` | The `AgentHost` state machine and the dispatch protocol: pre-check, staging, atomic authorization, per-Run launch, restart recovery | in-module state-machine tests; app `tests/edge_end_to_end` |
| `run_edge` | `RunEdge` (`Alternates` / `Follows` / `Verifies`) and `ResolvedEdge`; the cycle check at authorization | in-module |
| `staging` | The host-private staging directory and the Run workspaces; promotion by rename; producer never sees staging | in-module; `verify:alternates-isolation` |
| `process` | Launching, observing, cancelling a producer process | `tests/fake_claude` |
| `adapters` | The `HarnessAdapter` seam and the L1 argv adapter; detection is version-only and never burns a turn | `tests/pi_live_smoke` (live, opt-in) |
| `lib` (`Tier`) | The adapter capability tiers L0 / L1 / L2 | wire-spelling test |

### L3 · `refrain-app` — use cases

| Module | Owns | Proven by |
|---|---|---|
| `application` | The one router: `ProjectInput` (35 variants) → `ProjectOutput` (20 variants); holds the app store, the open projects, the KARA machine, and the Config snapshot | `tests/project` |
| `native_document` | `DocumentSurface` — the native editing state machine: bytes, selection, IME composition, undo, and bounded block projections. Three operations: `open`, `apply`, `project` | `tests/editor_walkthrough`, `native_history`, `revert`; `verify:editor-kernel` |
| `document` | Document lifecycle: open, continuity hydration, journal replay, save confirmation — and the DTOs | `tests/editor_walkthrough` |
| `dispatch` | The dispatch use case: the *order* knowledge (draft → authorize → launch), never the rules | `tests/dispatch` |
| `collect` | Collecting an attempt: validate against the **frozen** request, then complete, then freeze proposals — in that order | `tests/collect`, `k3_full_flow` |
| `decide` | Committing a decision batch and countermanding a merged one; both directions through the same compare-and-swap writer | `tests/decide_durability`, `countermand` |
| `journal` | The entity↔row translation; `StoreJournal` implements the host's `HostJournal` | `tests/journal` round-trips entities field by field |
| `mailbox` | What the mailbox shows: proposals merged with the author's arrangement into one screen | `tests/mailbox_service` |
| `harness` | Probing which harnesses this machine has, and saying why one is unusable; 15-second TTL cache | in-module |
| `history` | History and annotation *views* — judged facts, not raw rows | `tests/annotate`, `native_history` |
| `scope` | The two text questions between a frozen request and the open manuscript: `before_sections`, `locate_scope` | `tests/scope`, `scope_scale` |
| `upstream` | Feeding the upstream artifact into a promoted request — the content half of `Follows` / `Verifies` | `tests/upstream`, `edge_end_to_end` |
| `cancel` | Whether *this* Run can be cancelled *now*, and what the author should do instead when it cannot | `tests/cancel` |
| `review` | Rebuilding a domain `Proposal` from a stored row | `tests/review_round_trip` |
| `native` | `native_health` — protocol agreement between the two build modes | in-module |

### L4 · `apps/native/host` — the bridge

| Module | Owns | Proven by |
|---|---|---|
| `staticlib` | The one C entry, `refrain_native_dispatch`; the only place a raw pointer enters Rust (resolved to a slice immediately) | in-module borrow tests; `verify:unsafe-surface` |
| `protocol` | The generated ABI layout — regenerated from `protocol/host.json`, never hand-edited | the generator's `--check` stage; `protocol.test.ts` (codec, fingerprint) |
| `document` | The document sessions and the action demux (health / project / open / input / projection); the protocol-version check | via app tests and e2e |
| `project` | `ACTION_PROJECT`: decode one `ProjectInput`, call the router, lend back a bounded reply; `NativeProjectPlatform` (native dialogs; `REFRAIN_AUTOMATION_ROOT` for e2e). A reply that would overflow the bound is degraded by `truncate_output`, never silently cut | `verify:wire-shapes` |
| `contract` | The health use case mapped onto the generated contract: version agreement in, the health response shape out | in-module |

### L5 · `apps/native/src` — the surface

| Module | Owns | Proven by |
|---|---|---|
| `app.zon` | The shortcut and menu declaration — one command-id space for both | `verify:command-space` |
| `app.native` | The markup: notice bar and status line, event bindings | compiled against the model contract at build time |
| `core.ts` | `Model`, `Msg`, `update`, `commandMsg`, `viewUnbound` — interface state only | `core.test.ts` on the Null platform |
| `workbench.ts` | The eight destinations and the navigation rules: indices, the needs-a-document mask, layout fractions | `workbench.test.ts` |
| `roster.ts` | The roster cursor invariant: the cursor always points at an existing row, or −1 on an empty roster | `roster.test.ts` |
| `wire_json.ts` | JSON byte mechanics for the core: concat, escape, unescape, ordinal field reads — the requests a key press or a timer must build without a Zig event | `wire_json.test.ts`; shape parity pinned by `verify:wire-shapes` |
| `app_main.zig` | The shell: screens, fonts, menus, the context menu, KARA and theme wiring | in-file `test` blocks; e2e journals |
| `host_bridge.zig` | The ABI client: adopting the borrowed projection into module-lifetime storage | e2e; `verify:native-theme-pixels` |
| `project_request.zig` | The write side of the surface: one function per `ProjectInput` entry, nothing decided | in-file tests; `verify:wire-shapes` |
| `project_view.zig` | The read side: opaque reply bytes → rows (file tree, rosters); the Chinese labels | in-file tests |
| `snapshot.zig` | The cursor over opaque JSON — arrays included, which the SDK's primitive lacks | in-file tests |
| `workbench_view.zig` | Destination names and hints, indexed exactly as `workbench.ts` orders them | index agreement reviewed |
| `document_language.zig` | Wire code → SDK syntax grammar; unknown falls back to plain | in-file tests |
| `corners.zig` | Corner geometry: the five scales and their G-continuity (n = 4.2 is G3.2, not G4) | `verify:corner-authority` |
| `veil.zig` | The KARA veil: the 22% paper-gradient geometry, the chrome suffix commands, the interrupt-label table | in-file tests |
| `panel_stack.zig` | The visible panel stack: depth → reserve → track shift (the semantics mirror `workbench.ts`; the stage rule keeps every layer on one side) | in-file tests; vectors shared with `workbench.test.ts` |
| `commands.zig` | The command table: id → Chinese label → key hint — one authority that buttons, menus, and shortcuts all read | `verify:command-space` |
| `motion.zig` | Motion tokens: the named durations, the one easing pair (enter decelerate, exit near-accelerate), the breath loop — no animation carries its own numbers | in-file tests |
| `material.zig` | The panel-material recipe table (solid/acrylic/liquid — surface blend, backdrop-blur radius, sheen stops); the manuscript track never takes it | in-file tests |
| `material_paint.zig` | Recipes → pixels: surface/border blending, the one-line widget apply, the sheen plan | in-file tests |
| `generated/` | `protocol.ts` / `protocol.zig` / `themes.zig` — regenerated, never edited | `verify:themes-current`, protocol `--check` |

---

## The wiring graph

The whole system, drawn as links rather than boxes. Each link has a name, a
schema, and a gate; the table below the diagram says what crosses and what
never does.

```
  declarations              interface state                 platform + drawing
  ┌────────────┐   W1      ┌──────────────────┐            ┌───────────────────────┐
  │ app.zon    │──────────▶│ core.ts          │  model     │ app_main.zig          │
  │ app.native │  Msg      │ workbench.ts     │───────────▶│ project_view.zig      │
  └────────────┘           │ roster.ts        │  indices   │ corners.zig …         │
                           └──────┬───────────┘            └─────────▲─────────────┘
                                   │ Cmd.request                     │ W4: reads Model +
                                   ▼                                 │ borrowed projection
                           ┌─────────────────────────────────────────┴─────────────┐
                           │ project_request.zig · host_bridge.zig                 │
                           └──────────────────────────┬────────────────────────────┘
                                                      │  W2 request · W3 response
                                   one C ABI entry — refrain_native_dispatch
                                   five actions, bounded buffers, pointer-lent text
                                                      │
                           ┌──────────────────────────▼────────────────────────────┐
                           │ L4 bridge: staticlib · document.rs · project.rs       │
                           └───────┬──────────────────────────┬────────────────────┘
                        W6 document│                          │W5 project channel
                        channel    ▼                          ▼
                           ┌───────────────┐          ┌───────────────────────────┐
                           │ DocumentSurface        │ Application::project      │
                           │ open·apply·project     │ ProjectInput → ProjectOutput│
                           └──────┬────────┘          └─────┬───────────┬─────────┘
                                  │              W7 store   │           │ W8 host
                                  ▼                         ▼           ▼
                           ┌─────────────────────┐   ┌───────────────┐
                           │ L1 refrain-store    │◀──│ L2 refrain-host│  HostJournal
                           └─────────┬───────────┘   └───────┬───────┘  (W9, a trait)
                                     └───────────┬───────────┘
                                                 ▼
                                     ┌─────────────────────┐
                                     │ L0 refrain-core     │  depends on nothing
                                     └─────────────────────┘
```

| Link | What crosses | What never crosses | Pinned by |
|---|---|---|---|
| **W1 · command space** — `app.zon`/menus/markup → `commandMsg` → `Msg` → `update` | A command id becomes one `Msg`; keyboard and menu are the same path | A second dispatch table (the old frontend had two; they drifted) | `verify:command-space` |
| **W2 · request path** — `update` → `Cmd.request` → `host_bridge` → the C ABI | ABI scalars + a bounded payload (≤ 12,000 bytes of event text) | JSON the core parsed itself (the subset has no parser); non-ASCII in rodata | protocol `--check`; NS9001 |
| **W3 · response path** — Rust → `dispatch_ok` / `dispatch_err` → `update` | Revision, status, projection *metadata*; a pointer into Rust memory for the text | The manuscript as data — see below | `verify:bridge` |
| **W4 · view read** — Zig reads the `Model` + `host_bridge.documentView()` | Indices and counts from the Model; the borrowed projection text from the bridge | Manuscript bytes inside the Model | the e2e journals; `verify:native-theme-pixels` |
| **W5 · project channel** — `project_request.zig` → `host/project.rs` → `Application::project` | One `ProjectInput` JSON in; one bounded `ProjectOutput` JSON out (overflow degraded by rule, not by cutting) | A second way to reach a use case; filesystem paths composed in the core | `verify:wire-shapes` |
| **W6 · document channel** — `host/document.rs` → `DocumentSurface` | `open` / `apply` / `project` against a session id; the projection lent back | A second document state machine | `verify:editor-kernel` |
| **W7 · store access** — use cases → `ProjectStore` & friends | Rust calls, typed errors | SQL outside the store crate | `verify:write-path` |
| **W8 · host access** — use cases → `AgentHost` | `HostCommand`s in; facts out | A Run write from anywhere but the host (INV-12) | reviewed; the journal seam |
| **W9 · the journal seam** — `AgentHost` ↔ `HostJournal` trait | Entities serialized with their query columns | The host naming a database; the store naming a `ReviewTask` | two implementations: `StoreJournal` in production, in-memory in host tests |
| **W10 · generation** — build time | `protocol/host.json` → Rust/TS/Zig/C header; `THEMES` → `themes.zig`; `skill_doc()` → `docs/SKILL.md` | A hand-edited generated file | `--check` stages, `verify:themes-current`, `verify:skill-doc-current` |
| **W11 · frame channel** — SDK `frameMsg` → `update` → `projectionColumnsEm` → request → `typeset` | Real window pixels each frame; the column count re-derived from the typography values and re-projected when they move | A fixed `DOCUMENT_COLUMNS_EM`; DPI guessing in the view | `core.test.ts` frame cases |
| **W12 · save channel** — `document_save` → `native-save` keyed request → `save_ok` / `save_err` | The save's own reply as the only proof of "saved" (`savedRevision`); the flight flag `savePending` | A save racing keystrokes on one shared channel key (the in-flight save would be superseded and the "saved" claim a guess) | `core.test.ts` save-point cases |

Three traits are the deliberate test seams, each with exactly two
implementations (the project's rule for when a trait may exist):

- **`HostJournal`** (W9) — the host's persistence: `StoreJournal` in
  production, in-memory in the host's own tests.
- **`ProjectPlatform`** (W5) — the chooser dialogs: `NativeProjectPlatform`
  (real dialogs, plus the automation override e2e uses), a scripted platform
  in use-case tests.
- **`HarnessAdapter`** (L2) — the producer channel: the L1 argv adapter in
  production, fakes in `tests/fake_claude.rs`.

---

## The missing links

The honest register of what does not exist yet. Each entry names the module
that already waits at one end, the link that does not exist, and what closes
it. A ◐ in the function matrix points here.

| # | The gap | What already waits | The missing link |
|---|---|---|---|
| **M1–M5** | **Landed in v0.3.0.** KARA's event stream (produced where the facts happen, veil renderer), typography crossing into the projection (settings sliders included), material-draft resolution (`CommitMaterialDraft`, promote to chapter), the cross-document block jump (open-then-jump sequenced), anchored ranges in the projection (dots and the bento paint them) | — | — |
| **M6** | **The un-landed screens: PDF reading, diagrams.** The facts exist (`block_shape::Table` knows a table's shape; `ingest/pdf` extracts text), the screens do not. The table stays editor-aligned text by decision — the binding constraint outlives the old implementation, see *Why a table is aligned text*; PDF and diagrams move to the next version | the domain facts and the constraint essays | One screen each for PDF and diagrams, on the native surface, bound by the recorded constraints |
| **M7** | **Icons have no consumer.** `icons.rs` normalises and content-addresses an author's image; nothing above the store reads it (the Universal Button is not on the native surface) | `icons.rs`, `tests/icons.rs` | The surface that offers and shows the icon |
| **M8** | **Replay cannot verify the manuscript node.** The e2e journals replay with `--no-verify` because the projection lives in `host_bridge`'s module buffer, not in the core Model — the replayer feeds host answers to the core and the view has no path to the text | the journals, the a11y comparison (the only differing node is the manuscript textbox) | Moving the projection into the Model (~11.5 KiB per frame through core — measure before signing) and re-enabling `--verify` |
| **M9** | **The producer runner.** Dispatch through authorization, `LaunchRun`, collect, review, and the downstream auto-launch are all wired and tested — but nothing in the shipped app runs the agent process: no production code calls `HarnessAdapter::dispatch`/`observe`, and no one writes `result.md` or completes the dispatch. The native host is a synchronous ABI with no background runner; the old desktop's Tauri runner was never re-grown. The manual round trip (L0) works: `LaunchRun` promotes the frozen request into the workspace, the author runs the agent by hand, and collect reads the artifact | `adapters.rs` (dispatch/observe), the workspace layout, `CompleteDispatch`, and every domain test that assumes the runner exists | A runner that launches authorized Runs, observes their output, writes `result.md`, and completes dispatches — plus the verifier-comments consumer (`AgentComment` is parsed and then silently dropped at collect) and the orphan-downstream cleanup (a failed upstream leaves its followers waiting forever) |

Wired but awaiting a real-machine signature, rather than a link: IME
composition (`SetComposition` / `CommitComposition` / `CancelComposition` are
implemented and `verify:native-ime` exists) on Windows and macOS.

---

## How a change reaches the manuscript

The whole product is this sequence. Every step is refusable, every refusal is
named, and each step names the link it rides.

1. **Author selects scopes** and writes a request. (W1, W4)
2. **`context_compiler::compile`** freezes a request package: the chosen scopes
   verbatim, the context, the contract, and a digest. (L0)
3. **Author clicks dispatch.** `dispatch.rs` walks the order; `AuthorizeDispatch`
   checks that what was clicked is what was staged, mints Runs, and resolves
   edges to ids. (W5 → W8)
4. **`host::LaunchRun`** promotes the frozen request into the Run's workspace by
   *rename*. Edge constraints are enforced here: a Run that follows or verifies
   another may not start before that other is terminal. `upstream.rs` then adds
   the upstream artifact to the promoted copy — the frozen bytes are never
   touched. (L2, W9)
5. **The producer runs** and writes `result.md`. (`HarnessAdapter`)
6. **`app::collect_attempt`** parses the artifact against the **frozen** request
   — never against the artifact's own claims — and turns replacements into
   proposals. (L3)
7. **Author decides** each proposal. `app::decide` records the verdict in the
   append-only ledger. (W5 → L1)
8. **Only then** does text change — through the same compare-and-swap writer as
   any other commit, in both directions (a countermand rides the same path).
   (L0 → L1)

The freezing in step 2 is what makes step 6 honest: if the author edited a scope
after dispatching, the proposal fails loudly rather than being applied to text
the agent never saw.

---

## Orchestration edges

A Task may have several Runs. An edge says how one Run relates to another.

| Edge | Meaning | Enforced by |
|---|---|---|
| `Alternates` | Same question, independent answers | Imposes **no** order. Independence comes from the request being frozen before any peer produced anything (`verify:alternates-isolation`) |
| `Follows` | This Run needs the upstream's artifact | May not launch until the upstream is terminal; the artifact enters the promoted request whole |
| `Verifies` | This Run reads another's work and reports | May not launch until the subject is terminal; **may not propose edits** — an artifact with replacements is refused whole |

`RunEdge` carries positions (the author points at "the second one"); `ResolvedEdge`
carries ids, bound at authorization because that is when ids exist. The cycle
check runs at authorization, before anything is written, because the
authorization is immutable (INV-14). Both survive a crash: the edge is part of
the `Run` entity that the journal writes. The dispatch use case computes the
edges from one word (`alternates` / `follows` / `verifies`): `Follows` chains
the N agents each to the previous; `Verifies` points every verifier at the
first, because a comment is not a verifiable subject.

---

## One authority per fact

Each of these exists exactly once. A second copy is a defect, not a convenience.

| Fact | Sole authority | What that forbids |
|---|---|---|
| Manuscript bytes, selection, composition, undo | `DocumentSurface` (`refrain-app/src/native_document.rs`) — three operations: `open`, `apply`, `project` | A second document state machine; selection, word boundaries, revision and viewport as a public surface anywhere else |
| Block boundaries | `refrain-core/src/source_layout.rs` — the byte scanner | A second scan anywhere (index, estimation, listing all reuse the layout) |
| Block ordinals | `refrain-core/src/searchable_block.rs` | An `Id` where a human-checkable position is meant |
| Chinese tokenisation | `refrain-core/src/chinese_index.rs` — one function, both sides | Bigramming the index but not the query (silent zero results) |
| Line breaking | `refrain-core/src/typeset.rs` | A second set of rules. The SDK breaks only at space and tab, which no Chinese paragraph contains, so this is ours by necessity |
| Full/half-width conversion | `refrain-core/src/text_width.rs` | A conversion table in the surface |
| Which output a project input produces | `ProjectOutput::into_opened` / `into_imported` | Rebuilding the mismatch error behind a catch-all arm at each call site, which also hides a new variant from review |
| Settings | `ConfigStore::apply`, reached through `Application::apply_config` | A string key/value update path. The change set is an exhaustive enum |
| An agent's persona (work / cosplay) | `refrain-core/src/persona.rs` | A Boolean "is cosplay" flag; the author's bytes pass through untouched in both modes |
| What the mailbox shows | `refrain-app/src/mailbox.rs` | A second place that merges proposals with the author's arrangement |
| Error kinds | `refrain-core/src/error.rs` (`ErrorCode`) | An interface parsing an English message to decide behaviour (INV-15) |
| Artifact rejections | `refrain-core/src/agent_protocol.rs` (`ArtifactErrorCode`) | Documentation that enumerates from memory (INV-16) |
| Theme colours | The `THEMES` table in `scripts/generate-themes.ts` | A hand-kept copy. Four anchors per theme; everything else derives |
| Corner geometry | `apps/native/src/corners.zig` | A bare radius number anywhere else |
| Protocol layout | `apps/native/protocol/host.json` | A hand-edited offset in any generated file |

### Persisted state is discarded when it cannot be trusted

Undo history is keyed by `content_digest`. When a file changed outside RefRain,
the stored head no longer describes those bytes, so the history is dropped
rather than replayed onto text it was not written against.

### The manuscript never crosses as data

Text does not travel as JSON, as `number[]`, or through the bounded response
channels (40,960 bytes for a projection, 12,000 for event text — both pinned in
`apps/native/protocol/host.json`). The response lends a pointer into Rust memory
with the projection's lifetime. Project-channel replies share the same bound,
so every catalogue, roster, and mailbox answer is paged or trimmed by rule
(`truncate_output`) rather than allowed to overflow silently. The handshake
compares `protocol_version` and the capability mask, and refuses to run on a
mismatch rather than continuing with drift.

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
| **Mailbox** | All of a Root's proposals merged with the author's arrangement into one screen: three boxes (draft / unread / done), pin and discard, and countermand on what was merged. `refrain-app/src/mailbox.rs` |
| **Countermand** | The reverse verdict on a merged proposal: append-only in the ledger, the text reverted at an anchor rebuilt by the merge rule itself, persisted under the same compare-and-swap as a commit |
| **Persona** | The identity an author gives an agent, in exactly two modes — `Work` (the author's bytes are the whole identity) or `Cosplay` (those bytes plus one global preset). `refrain-core/src/persona.rs` |

### The surface

| Term | Meaning |
|---|---|
| **Destination** | One of the eight places the workbench can be (manuscript / files / review / dispatch / mailbox / connections / history / settings). An index in the Model, never eight Booleans. `workbench.ts` |
| **Roster** | A list of rows with a cursor: the cursor always points at an existing row, or −1 on an empty roster. Four destinations share the invariant. `roster.ts` |
| **Projection** | The bounded window of blocks the bridge lends to the surface, with its line starts. The surface draws it; it never becomes a copy of the document. |
| **Document session** | One open document on the document channel, keyed by an id the bridge mints. |

---

## Where to look when something is wrong

This table is the fastest path from a symptom to a module.

| Symptom | Start here |
|---|---|
| Text renders wrong, cursor jumps, selection breaks | `refrain-app/src/native_document.rs` — the one document state machine |
| A line breaks in the wrong place | `refrain-core/src/typeset.rs` — the CLREQ 禁则 authority |
| A block's boundary is wrong | `refrain-core/src/source_layout.rs` — the byte scanner is the only authority |
| A block's estimated height is off | `refrain-core/src/block_shape.rs` — shape from bytes, pixels stay in the view |
| A shortcut does nothing | `apps/native/app.zon` declares it, `core.ts::commandMsg` maps it |
| A menu item and its shortcut disagree | They cannot — both ride W1. If one exists without the other, `verify:command-space` is the gate to read |
| Search returns nothing, or the wrong order | `refrain-store/src/project/search.rs`, `refrain-core/src/search_rank.rs`, `chinese_index.rs` |
| A Chinese word of two characters finds nothing | `refrain-core/src/chinese_index.rs` — one side of the transformation was skipped |
| A file did not save, or saved to the wrong place | `refrain-store/src/atomic.rs`, `root.rs` |
| A crash left a `.writing` file | `refrain-store/src/atomic.rs` — residue recovery and the owner marker |
| An agent's reply was rejected | `refrain-core/src/agent_protocol.rs` — the parser and its error codes |
| A request carried the wrong context | `refrain-core/src/context_compiler.rs` |
| A Run started too early, or not at all | `refrain-host/src/host.rs` — `LaunchRun` and the edge constraints |
| A downstream Run did not see the upstream's work | `refrain-app/src/upstream.rs`, `refrain-core/src/upstream_work.rs` |
| A proposal could not be applied | `refrain-app/src/decide.rs`, `refrain-core/src/manuscript/review.rs` |
| A countermand reverted the wrong text | `refrain-app/src/decide.rs` — the anchor is rebuilt by the merge rule itself |
| A mailbox entry sits in the wrong box | `refrain-app/src/mailbox.rs` — proposals and the author's arrangement merged into one screen |
| Orchestration state was lost | `refrain-app/src/journal.rs` — the entity/row translation |
| A Run cannot be cancelled though a process is alive | `refrain-app/src/cancel.rs` — which states are cancellable |
| History will not roll back to a step | `refrain-app/src/native_document.rs` (`RevertTo`), `refrain-store/src/history.rs` |
| An annotation lost its anchor | `refrain-store/src/annotations.rs` — the store keeps the anchor; the live manuscript judges the drift |
| A colour is wrong, or a theme looks flat | `apps/native/src/generated/themes.zig` — generated from four anchors per theme |
| A corner is the wrong shape | `apps/native/src/corners.zig` — the five scales and their G-continuity |
| A roster cursor points at a vanished row | `apps/native/src/roster.ts` — the one cursor invariant |
| A screen shows stale facts after an action | The action's reply is the refreshed view (`NativeSaved` → history, mailbox actions → mailbox); a second read means the first lied |
| The protocol handshake fails | `apps/native/host/src/contract.rs`, `protocol/host.json` versions |

---

## Gates

`bun run gate` runs every gate script on disk; `verify:gates-run` compares the
two lists and fails when a script exists that nothing invokes. The count is
deliberately not written here — a number in prose has no gate behind it and
drifts. Run the command to see it.

Two evidence sets are split out of the blocking gate because a data-layer
assertion cannot make their claims: `bun run evidence:pixels` (real-window
pixel checks — today that is `verify:native-theme-pixels`, which needs a GPU
view) and `bun run evidence:performance` (the measured performance gates). A
green `gate` run is therefore not the whole story. The tier A gates run as
compiled binaries, never from source: run `bun run scriptc:build` first — a
missing artifact fails the gate rather than falling back to the interpreter.
The Rust checks are **not** among either and must be run separately:

```sh
bun run scriptc:build    # tier A gates execute the compiled artifact
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
bun run gate
```

All five, every time. A defect where a doc comment attached to the wrong
function was caught only by clippy while the gate was fully green.

A gate here is expected to be **injection-verified**: break the thing it guards,
watch it go red, restore, watch it go green. A gate that has never been seen to
fail is a gate that has proven nothing — see [CONTRIBUTING.md](CONTRIBUTING.md).

### A red gate can be the environment, not the code

The browser gates that once measured text geometry left with the surface they
measured. The principle they taught survives them: before treating a red as a
defect, run the same gate on the base commit with no local changes — identical
failure text is the evidence that the machine, not the change, is red. Facts
that must hold regardless of environment are asserted by tests that need no
window, never only by a rendered frame.

---

## Related documents

- [README.md](../README.md) — what RefRain is, and how to install it
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
- [ROADMAP.md](ROADMAP.md) — what is planned (written in Chinese)
- [AGENTS.md](AGENTS.md) — working discipline for agents in this repository
- [SKILL.md](SKILL.md) — the agent protocol (generated)
- [LICENSE](../LICENSE) — MPL 2.0

---

## Technology

The projects this one stands on. Versions are pinned exactly in
`Cargo.toml` / `package.json`; this table is the thank-you, not the authority.

| | |
|---|---|
| **Language** | [Rust](https://rust-lang.org) for the domain; [Zig](https://ziglang.org) for platform and drawing; a restricted [TypeScript](https://www.typescriptlang.org) subset for interface state |
| **Application shell** | [Native SDK](https://native-sdk.dev) (`@native-sdk/cli` 0.8.1, patches carried in `patches/`) — native rendering, no WebView, no JavaScript runtime in the shipped binary |
| **Surface** | `.native` markup compiled against the model contract; [Biome](https://biomejs.dev) formats the TypeScript |
| **Build tooling** | [ScriptC](https://github.com/vercel-labs/scriptc) compiles the tier A gates and release scripts to native binaries; [Bun](https://bun.sh) runs the rest. Build-time only — neither ships. |
| **Storage** | [SQLite](https://sqlite.org) through [rusqlite](https://github.com/rusqlite/rusqlite) (bundled), FTS5 `unicode61`, and an application-level bigram tokeniser |
| **Config format** | [TOML](https://toml.io) — a real format needs a real parser; a hand-rolled one would re-create the escaping edge cases the Config authority exists to refuse |
| **Hashing** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) |
| **Ids** | [UUID](https://github.com/uuid-rs/uuid), v7 |
| **Serialisation** | [Serde](https://serde.rs); [specta](https://github.com/specta-rs/specta) derives the cross-boundary type descriptions; the wire protocol is generated from one schema (`apps/native/protocol/host.json`) into Rust, TypeScript, Zig and a C header |
| **Scanning** | [memchr](https://github.com/BurntSushi/memchr) |
| **Errors** | [thiserror](https://github.com/dtolnay/thiserror) |
| **Filesystem walk** | [ignore](https://github.com/BurntSushi/ripgrep) — the traversal ripgrep uses, so a manuscript folder full of build output does not drown the index; [rayon](https://github.com/rayon-rs/rayon) shares the work across the walk, the sort, and the search |
| **Recycle bin** | [trash](https://github.com/Byron/trash-rs) — the only cross-platform route to a *recoverable* delete |
| **Icons** | [usvg](https://github.com/linebender/resvg) / resvg / tiny-skia for SVG, [image](https://github.com/image-rs/image) for PNG — judged by content, never by the picker's accept string |
| **Material ingestion** | [lopdf](https://github.com/J-F-Liu/lopdf) for PDF text, [zip](https://github.com/zip-rs/zip2) for the office formats, [html5gum](https://github.com/untitaker/html5gum) for HTML — all local, sources never written |
| **Dialogs & directories** | [rfd](https://github.com/PolyMeilex/rfd) for native choosers, [directories](https://github.com/dirs-dev/directories-rs) for the application data directory |
| **Process signals** | [nix](https://github.com/nix-rust/nix) on Unix, for cancelling a producer tree |
| **Line breaking** | `refrain_core::typeset` — see *Why RefRain breaks its own lines* |
| **Imported sources** | An imported PDF is rendered for reading only; RefRain never writes back to it |

### Why RefRain breaks its own lines

The browser can wrap text. RefRain wraps it instead, because the two things it
will not do are exactly what CJK typesetting needs: compress a full-width
punctuation mark at the end of a line, and hang one in the margin.

`refrain_core::typeset` is one Rust module — a string and a preset in, break
offsets out. The projection carries the offsets across the bridge
(`DocumentProjection::line_starts`), and Zig draws them rather than letting the
SDK wrap the text itself, so **not one byte enters the text**: a caret offset is
still a byte offset. Two presets, because the rules genuinely conflict —
Simplified Chinese compresses that mark by half an em (GB/T 15834 §5.1.10)
where Japanese keeps the space and hangs the mark instead (JLREQ §3.1.9).

The breaker is greedy, which measurement supports rather than excuses: Chinese
breaks almost anywhere, so greedy already matches the whole-paragraph optimum
while a dynamic program costs 960× more for nothing. The optimiser runs only on
paragraphs holding a long unbreakable run — a Latin word, a URL, inline code.

Computing breaks ourselves also makes them identical on every platform, which
browser wrapping does not guarantee. The old surface pinned that with a
cross-platform fingerprint gate (`verify:layout-parity`); the gate left with the
browser it was measuring, and the rules are now pinned by the Rust tests in
`typeset.rs` itself.

### Why a table is aligned text, not a table — the constraint outlives the implementation

A GFM table could become a real table widget. It would look better: cells wrap
inside their own column, so a wide table never overflows the measure. The reason
RefRain does not do this is a second coordinate system, and that reason survives
the rewrite even though the implementation that carried it did not.

The editor holds one invariant above the others: **a caret offset is a byte
offset**. Everything downstream depends on it — the change ledger stores byte
ranges, the line breaker walks a character array. A real table replaces that
single axis with "row 2, cell 3": a caret needs translation between table
coordinates and byte offsets, a selection across two cells is discontinuous in
the source because it steps over a `|`, and the change ledger and the line
breaker would both need new range types.

The old surface honoured the invariant with inline-block shells and a shared
`min-width` per column — no byte added, the columns still lined up. That DOM
implementation was deleted with the surface; the native table screen has not
landed yet (M6 in *The missing links*). Whatever replaces it is bound by the
same constraint: a table adds no byte, or it does not ship. The two measurements
that shaped the old implementation — the delimiter row must receive a column
width without contributing one, and column width is measured on the untrimmed
cell — are recorded here because the next implementation will meet the same two
traps.

### 图与 PDF 阅读：裁定随实现一起等待

步骤 10 之前这里有两节裁定——为什么用 nomnoml 而不是 Mermaid、为什么导入的
PDF 只读不回写。两条依赖（nomnoml、pdf.js）都随旧 DOM 前端一起删除，而 Native
侧的图与多格式阅读属于尚未接上的屏幕（M6）。

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
