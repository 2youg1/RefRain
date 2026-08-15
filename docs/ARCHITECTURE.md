# Architecture

This document shows the parts of the system. It shows the functions, the layers,
the modules, and the links between them.

Read this document one time from the start to the end. Then keep two pages open
while you work: the function matrix and the wiring graph.

The data in this document comes from the repository at your commit. If the data
and the code do not agree, the code is correct. Correct this document in the
same change.

Write in ASD-STE100 Simplified Technical English. Keep the sentences short. Give
the rule, then give one reason for the rule. Do not write a history of the work.

---

## What RefRain is

RefRain is a local writing workbench for long manuscripts. The author writes in
Markdown and in a fixed set of plain-text formats. An agent can propose changes.
Only a human click puts a change into the text.

Four invariants control the design. Each invariant has a gate. The gate fails if
the invariant breaks.

| Invariant | Effect in the code |
|---|---|
| **No network** | The application process opens no sockets. `verify:no-network` finds network APIs. |
| **Only a human merges** | An agent makes proposals. A change reaches the manuscript only after a recorded decision in the Verdict Ledger. |
| **The Source Backup is read-only** | `.refrain-source/` holds the files from the time of adoption. Do not write to it. `verify:write-path` finds a path that goes there. |
| **Delete means the recycle bin** | Do not remove a file from the disk directly. `verify:trash-only` finds a direct removal. |

---

## The design rules

These five rules have an order of importance. The other sections show what the
rules mean today.

1. **Make deep modules.** A deep module has a narrow interface and hides much
   work. Example: `typeset` receives a string and a preset. It returns break
   offsets. It hides the CLREQ and JLREQ rules, the measurement tables, and the
   optimizer. A module must own one invariant or one rule. If it owns neither,
   do not make the module.
2. **Keep one authority for each fact.** Each rule, each state transition, and
   each stable fact is in one module only. A second copy is a defect. Two copies
   become different, and no gate reports the difference.
3. **Point the layers down.** The order is domain, persistence, orchestration,
   use cases, bridge, surface. A layer can use only the layers below it.
   `refrain-core` uses no other crate in the workspace. Put a rule there if the
   rule must be true everywhere.
4. **Keep the links few, and give each link a name.** A link is a seam with a
   schema and a gate. Nothing crosses a layer boundary at a different place.
   Each link also shows what must never cross it. The manuscript bytes never
   cross as data.
5. **A feature is a module and its wiring.** Put new work in a deep module in
   the layer that owns the invariant. Then connect the module through the
   existing links. Do not put the work in the router's match arms. Do not make a
   second authority beside an old one.

The tests have the same shape. A **module** has unit tests and integration
tests. A **link** has a gate or a round-trip test across the seam. A **layer**
has a boundary gate: `verify:core-purity`, `verify:write-path`, and
`native check . --strict`. A **function** has a use-case test from the start to
the end: `tests/k3_full_flow.rs`, `tests/edge_end_to_end.rs`, and the eight e2e
journals.

---

## The surface rules

### The stage rule

The manuscript is the only stage. The surface has two interaction zones. Do not
add a third zone.

- **The function rail.** All tool surfaces enter from the same side as a panel.
  The tool surfaces are files, review, dispatch, mailbox, connections, history,
  and settings. A tool must not open above the text. The rail is open at the
  first frame, because the first destination is Files. The files screen shows
  the destination tree at its top. The tree shows all eight destinations, and it
  shows the key chord on each row. The command palette draws the same tree from
  the same source.
- **The editing zone.** Text actions stay on the text. The right-click menu and
  the key chords do the work. In-place anchors attach to the line that they
  change. These anchors are part of the zone. They are not floating windows.

The rail also opens on hover. A 4 px strip at the left edge of the window opens
the rail to Files. A rail that opened on hover closes again when the pointer
leaves the rail. If the author uses the rail, the rail stays open. The rail
width gives the hysteresis: it opens at 4 px and closes after approximately
248 px.

### The layout of the layers

Put the layers in one row, at the side of the stage. The stage takes the space
that stays. Two results follow:

- A panel cannot cover the manuscript, because the manuscript is not in the
  space of the panel.
- The stage keeps a minimum of one layer width. Three layers at the default
  fraction of 0.32 leave 4 % of a 1250 px window for the text.
  `panel_stack.fittingDepth` removes the oldest layer instead. To get the third
  layer, the author moves the divider and makes the rail smaller.

### The rail register

The rail is a column of the page. It is not a box on the page. It takes no
corner and no outline. A rounded box is only for a control (`corners.zig`
`.control`) or for a surface that floats at the side of the manuscript
(`.bento`).

The shell paints the ground of the rail and its rule as one band, from the top
edge of the window to the bottom edge. Only the shell knows where these edges
are. The band belongs to the division between the two zones. It does not belong
to one layer. Thus more layers do not make more bands. Each layer in the rail is
transparent.

The rail has its own colour register. This register makes the two zones visible:

| Token | Use |
|---|---|
| `rail` | The ground of the rail |
| `rail-ink` | The primary text on the rail |
| `rail-faint` | The secondary text on the rail |
| `rail-rule` | The division at the right edge of the rail |

`rail.zig` owns this register. It has three functions: `band` for the ground and
the rule, `dress` for the recursive ink stamp, and `controlTokens` for the
control register.

The design has three planes: the rail is the desk, a card on the rail is a
sheet, and the manuscript is the page. A widget that owns a ground keeps the
paper register in it, and the ink stamp stops there. Rows are the only control
class that stays in the rail, thus `controls.list_item` moves as one unit. The
context menu floats above the manuscript, thus it states the paper register for
each field.

The ink and the ground must come from the same test. `railHasGround` is that
test. If the two tests are different, a screen shows rail ink on paper ground.

**The ground of the rail is always solid.** The panel material applies to a
surface that floats above the manuscript: a panel, a bento, the return card, a
menu, the palette. Such a surface mixes toward the paper below it, and that is
correct compositing. The rail does not float above the paper. It is a second
ground beside the paper. A recipe that mixes the paper into the rail makes the
desk the colour of the page: acrylic moved the `tou` ground from `#223b60` to
`#5c6c83` and made the disabled row register illegible. Liquid glass added a
second cost, because the recipe put the largest blur radius on a band the height
of the window: the reference renderer could not capture a frame. Both materials
are correct now. A pixel probe reads the same `#223b60` for each of the three.

The status line belongs to the manuscript column. It starts at the right edge of
the rail. The notice bar is different: it announces a refusal, it uses the full
width of the window, and it has its own `.alert` ground.

### Other surface rules

- There is no top bar. The window chrome stays with the platform. The window
  title, the menu bar, the status line, and the tray item carry the facts. A top
  bar would be the third interaction zone.
- Do not add a floating surface above the manuscript. There are two exemptions
  only: the agent-state recovery card (KARA), and the settings surface in
  fullscreen mode.
- Show a layer only when the task needs it. Print the key chord on the button in
  the layer. Escape closes one layer, the innermost layer first.
- The command palette opens in the rail as a tree. It is not an overlay. The
  tree shows the summary first. The author opens a node to see the detail.
- Give the mouse and the keyboard the same power. The mouse target is in the
  text or in the rail. Each button prints its chord. A flow that needs a large
  mouse movement is a defect. A flow that needs an unknown chord is also a
  defect.
- Open a layer at the side of the content. Do not replace the content. When the
  layer closes, the surface returns to the previous state.

---

## The function matrix

The rows are the functions of the product. The columns are the layers. A cell
gives the module that owns the function at that layer. A dash shows that the
function must not exist at that layer.

Status: **●** connected from the start to the end. **◐** the modules exist, but
a link is missing; see *Open items*. **○** not on the native surface.

| Function | L0 domain `refrain-core` | L1 persistence `refrain-store` | L2 orchestration `refrain-host` | L3 use cases `refrain-app` | L4 bridge `native/host` | L5 surface `native/src` | |
|---|---|---|---|---|---|---|---|
| **F1 · Edit the manuscript** | `manuscript/`, `source_layout`, `document_format` | `atomic`, `project`, `history` | — | `native_document`, `document` | `document.rs` | document Msgs in `core.ts`, `host_bridge`, `app_main` | ● |
| **F2 · Break lines, measure text** | `typeset`, `block_shape`, `text_width`, `inline_span` | — | — | projection in `native_document` | protocol layout | `host_bridge`, `app_main` | ● |
| **F3 · Plain-text formats** | `document_format`, `source_layout`, `typeset` code path | round-trip in `project` | — | `native_document` | `document.rs` | `document_language` | ● |
| **F4 · Roots and the catalogue** | `role` | `root`, `project`, `schema`, `files/index` | — | `application` | `project.rs` | `project_request`, `project_view`, `snapshot` | ● |
| **F5 · Search and jump** | `chinese_index`, `searchable_block`, `search_rank`, `inline_span` | `project/search`, `project/catalog` | — | `application` | `project.rs` | search box in `app_main`, `document_jump` | ● |
| **F6 · Settings** | — | `config` | — | `application::apply_config` | `project.rs` | settings screen in `app_main` | ● |
| **F7 · Harnesses and connections** | — | `config` | `adapters`, `Tier` | `harness` | `project.rs` | connections screen | ● |
| **F8 · Dispatch and edges** | `context_compiler`, `material_listing`, `upstream_work`, `persona` | `materials`, `orchestration` | `host`, `run_edge`, `staging`, `process`, `adapters` | `dispatch`, `scope`, `upstream`, `cancel`, `runner` | `project.rs` | dispatch screen, `LaunchRun` | ● |
| **F9 · Collect, review, decide** | `agent_protocol`, `manuscript/review`, `manuscript/decision` | `ledger`, `history` | Run records in `host` | `collect`, `decide`, `review`, `journal` | `project.rs` | review screen | ● |
| **F10 · The mailbox** | — | `mailbox` | — | `mailbox` | `project.rs` | mailbox screen | ● |
| **F11 · History and rollback** | `manuscript/persist` | `history` | — | `history`, `RevertTo` | `INPUT_REVERT_TO` | history screen | ● |
| **F12 · Annotations** | — | `annotations` | — | `history`, `Annotate` | `project.rs` | annotations section, anchor dots | ● |
| **F13 · Materials and import** | `material_listing` | `ingest`, `materials` | — | import in `application` | `project.rs` | import entries, disclosure menu, draft rows | ● |
| **F14 · KARA** | `kara` | `config` | — | `application::kara_step` | `project.rs` | `veil.zig`, the mode strip, the return card | ● |
| **F15 · Width conversion** | `text_width` | `history` | — | `ConvertWidth`, `scope` | `project.rs` | context menu | ● |
| **F16 · Themes and corners** | — | `config` | — | `application::apply_config` | `project.rs` | `generated/themes.zig`, `corners.zig`, `material.zig`, `material_paint.zig`, `rail.zig`, `workbench_view` | ● |
| **F17 · Icons** | — | `icons` | — | — | — | — | ○ no consumer above the store |
| **F18 · Health and the handshake** | `health` | — | — | `native` | `contract.rs`, `document.rs` | handshake in `core.ts` | ● |

A ◐ row or a ○ row shows the work for the next version. The modules in the row
have tests at their own layer. The link is missing. *Open items* gives the link.

---

## The layers

Dependencies point down only. Each layer holds one type of thing and refuses the
other types. A gate makes the refusal.

| Layer | Holds | Never holds | Enforced by | Scale (modules / lines) |
|---|---|---|---|---|
| **L0 `refrain-core`** — the domain | The product rules: manuscript, blocks, formats, line breaking, the agent protocol, ranking, KARA | A database, a file path, a process, a window | `verify:core-purity`, `#![forbid(unsafe_code)]` | 32 / 11,794 |
| **L1 `refrain-store`** — persistence | The two databases, the mutable disk paths, the atomic writer, the Root guard, the indexes, the Config file, the trash | Domain rules, orchestration semantics | `verify:write-path`, `verify:trash-only` | 23 / 8,893 |
| **L2 `refrain-host`** — orchestration | Task, Run, and Authorization state, staging, workspaces, process launch, harness adapters | The database. It writes through the `HostJournal` trait. Domain rules | INV-12 by review, and the journal seam | 6 / 4,751 |
| **L3 `refrain-app`** — use cases | The flows that need more than one layer below, the one `Application`, and `DocumentSurface` | FFI, raw pointers, platform APIs | `#![forbid(unsafe_code)]` | 17 / 8,493 |
| **L4 `apps/native/host`** — the bridge | The C ABI: one entry, the generated layout, the session table, bounded replies, the handshake | Product semantics. Those are Rust enums below | `verify:bridge`, the protocol generator `--check` | 6 / 1,660 |
| **L5 `apps/native/src`** — the surface | Markup and declarations, interface state, platform events, drawing | Manuscript bytes, product rules | `native check . --strict`; the layer table is in [AGENTS.md](AGENTS.md) | 21 hand-written / 14,372 and tests |

The line counts include each hand-written source file below `src/`. They do not
include the generated files (873 lines) and the four L5 test files (1,992
lines).

L5 has three strata. `native check --strict` and rule NS9001 enforce them.

- **Declarations** — `app.zon` for shortcuts and menus, `app.native` for
  structure and event bindings. No logic.
- **Interface state** — `core.ts` and its two helpers. The compiler accepts a
  restricted subset: numbers, strings, `asciiBytes` and `utf8Bytes` literals,
  array tables, and interface-annotated records. This stratum holds the `Model`,
  the `Msg`, and `update`. It must not hold manuscript bytes or a document state
  machine.
- **Platform and drawing** — the Zig files. They hold events, borrowed
  projections, non-ASCII labels, and geometry. They must not hold a second copy
  of the text, the selection, the composition, or the undo stack.

Three rules apply to L5:

- **The manuscript stays in Rust.** Zig draws a borrowed projection. The
  TypeScript core keeps a revision number. Neither holds the bytes.
- **Use the correct byte spelling.** `asciiBytes` is for command names, keys,
  paths, and protocol values. `utf8Bytes` is for text that a person reads. A
  JavaScript string is UTF-16 and the boundary is UTF-8. The wrong spelling
  changes a non-ASCII code unit into different bytes. Rule NS1064 finds this.
- **`update` always returns `[Model, Cmd<Msg>]`.** The SDK also accepts a bare
  model, but the compiled core tests the union with `Array.isArray`, and that
  test answers false for a tuple on the ScriptC lane. Write `[model, Cmd.none]`
  for "no effect". Never write a bare `return model`. The gate is the test
  "compiled lane: bare-sugar-free update snapshots after tuple and bare arms
  alike" in `app_main.zig`.

---

## The module inventory

This section gives each module, the thing that it owns, and the test that proves
it. "Tests" gives the integration files below the crate `tests/` directory. A
module with no test file has test blocks in the module.

### L0 · `refrain-core` — the domain

| Module | Owns | Proven by |
|---|---|---|
| `manuscript/` | The manuscript state machine: `SourceSnapshot`, `TextHead`, `TextAction`, `TextTransition`, undo regions. Sub-modules: `action`, `align`, `decision`, `persist`, `review` | `tests/manuscript_*`, `action_edits`, `decision_batch`, `review`, `plain_manuscript`, `block_text_*` |
| `source_layout` | The start and the end of each block: the byte scanner (`Markdown` or `Plain`) and the digest-bound `SourceLayout` | `tests/source_layout`, `block_boundaries`, `block_scan_parity` |
| `block_shape` | The type of a block and its approximate height: `BlockKind`, width units, hard lines | `tests/block_shape_scan` |
| `searchable_block` | The ordinal of a block. The agent and the index share this handle | indexed-search tests in the store |
| `chinese_index` | The bigram transformation for the index side and the query side; `Precision` | store `tests/fts_capability`, `block_search` |
| `search_rank` | The score above BM25: capped signals for path, block type, and role | in-module |
| `inline_span` | The inline Markdown markers in a block, and their removal for the index | in-module |
| `document_format` | The type of a document: the exhaustive `DocumentFormat` enum, the block scan, the extensions, the wire codes | exhaustive-match compile errors |
| `typeset` | CJK line breaking: the prose path and the code path, with two presets | in-module |
| `text_width` | Display width units and the full-width and half-width conversion table | in-module |
| `context_compiler` | The frozen dispatch package: section order, manifest, three-state tokens, and the fact-only narration | app `tests/dispatch`, `tests/collect` |
| `agent_protocol` | The artifact grammar: the scanner, each rejection in `ArtifactErrorCode`, and `skill_doc()` | `verify:docs-current`, `verify:skill-doc-current` |
| `material_listing` | The data about a material that an agent receives: outline, excerpt, `Disclosure` | in-module |
| `upstream_work` | The upstream artifact as a section in a downstream request | app `tests/upstream` |
| `persona` | The identity of an agent in two modes: `Work` and `Cosplay` | in-module |
| `kara` | The KARA state machine: six states, one transition function, named effects | in-module |
| `role` | `DocumentRole`: document, chapter, or material | wire-spelling tests |
| `health` | `HealthReport` | in-module |
| `id`, `digest`, `error` | `Id` (UUID v7), BLAKE3 digests, and `RefrainError` with `ErrorCode` | `verify:docs-current` |

### L1 · `refrain-store` — persistence

| Module | Owns | Proven by |
|---|---|---|
| `schema` | The two transaction domains (`app.db` and `refrain.db`) and the migration ladder | in-module |
| `atomic` | Atomic file replacement, crash checkpoints, and residue recovery with an owner marker | `tests/atomic` |
| `root` | The Root layout, the one Source Backup, and the path guards for each write | `tests/project` |
| `project` | `ProjectStore`: adopt, open, create, commit. Commit uses compare-and-swap against the `FileStamp` | `tests/project`, `plain_formats` |
| `project/catalog` | The document catalogue and its paging | `project/catalog/tests` |
| `project/search` | The FTS5 queries. Exact falls back to Loose | `tests/search*`, `block_search` |
| `config` | The Config authority: `config.toml`, the `ConfigChange` enum, and the refusal of a damaged or newer file | `tests/config` |
| `history` | The persisted Text Action history, to a depth of 64 | `tests/history` |
| `ledger` | The Verdict Ledger: append-only, idempotent, in decision order | app `tests/countermand` |
| `mailbox` | The arrangement facts: rank, pin, discard. Soft delete only | `tests/mailbox` |
| `orchestration` | Row access for Task, Run, and Authorization | app `tests/journal` |
| `annotations` | Highlight and comment rows: block identity, offsets, and the quote | `tests/annotations` |
| `icons` | The icon pipeline: SVG and PNG to one content-addressed 256² PNG | `tests/icons` |
| `materials` | Material draft rows and source preparation | app `tests/project` |
| `ingest` (`html`, `office`, `pdf`) | The six reference formats to plain text, locally. Sources are never written | `tests/ingest_security` |
| `files/index` | The workspace walk. The Source Backup does not enter | in-module |
| `application` | `ApplicationStore`: the machine-level facts in `app.db` | app tests |

### L2 · `refrain-host` — orchestration

| Module | Owns | Proven by |
|---|---|---|
| `host` | The `AgentHost` state machine and the dispatch protocol: pre-check, staging, atomic authorization, per-Run launch, restart recovery | in-module; app `tests/edge_end_to_end` |
| `run_edge` | `RunEdge` and `ResolvedEdge`, and the cycle check at authorization | in-module |
| `staging` | The private staging directory and the Run workspaces. Promotion is a rename | in-module; `verify:alternates-isolation` |
| `process` | The launch, the observation, and the cancel of a producer process | `tests/fake_claude` |
| `adapters` | The `HarnessAdapter` seam and the L1 argv adapter. Detection reads the version only | `tests/pi_live_smoke` |
| `lib` (`Tier`) | The adapter capability tiers L0, L1, and L2 | wire-spelling test |

### L3 · `refrain-app` — use cases

| Module | Owns | Proven by |
|---|---|---|
| `application` | The one router: `ProjectInput` (35 variants) to `ProjectOutput` (20 variants) | `tests/project` |
| `native_document` | `DocumentSurface`: bytes, selection, IME composition, undo, and bounded projections. Three operations: `open`, `apply`, `project` | `tests/editor_walkthrough`, `native_history`, `revert`; `verify:editor-kernel` |
| `document` | The document lifecycle: open, continuity hydration, journal replay, save confirmation | `tests/editor_walkthrough` |
| `dispatch` | The order of the dispatch: draft, authorize, launch. Not the rules | `tests/dispatch` |
| `runner` | The producer pump: one non-blocking pass for each `ReadHost` poll | `tests/runner` |
| `collect` | The collection of an attempt: validate against the frozen request, complete, then freeze the proposals | `tests/collect`, `k3_full_flow` |
| `decide` | The commit of a decision batch and the countermand of a merged one | `tests/decide_durability`, `countermand` |
| `journal` | The translation between entities and rows. `StoreJournal` implements `HostJournal` | `tests/journal` |
| `mailbox` | The content of the mailbox screen | `tests/mailbox_service` |
| `harness` | The probe for the harnesses on this machine, with a 15-second cache | in-module |
| `history` | The history and annotation views | `tests/annotate`, `native_history` |
| `scope` | `before_sections` and `locate_scope` | `tests/scope`, `scope_scale` |
| `upstream` | The upstream artifact in a promoted request | `tests/upstream`, `edge_end_to_end` |
| `cancel` | The states in which a Run can stop, and the alternative when it cannot | `tests/cancel` |
| `review` | The rebuild of a domain `Proposal` from a stored row | `tests/review_round_trip` |
| `native` | `native_health`: protocol agreement between the two build modes | in-module |

### L4 · `apps/native/host` — the bridge

| Module | Owns | Proven by |
|---|---|---|
| `staticlib` | The one C entry `refrain_native_dispatch`. The only place where a raw pointer enters Rust | in-module borrow tests; `verify:unsafe-surface` |
| `protocol` | The generated ABI layout from `protocol/host.json` | the generator `--check`; `protocol.test.ts` |
| `document` | The document sessions, the action demux, and the protocol-version check | app tests and e2e |
| `project` | `ACTION_PROJECT`: decode one `ProjectInput`, call the router, lend back a bounded reply. `NativeProjectPlatform` uses `REFRAIN_AUTOMATION_ROOT` for e2e. `truncate_output` degrades a reply that is too large | `verify:wire-shapes` |
| `contract` | The health use case on the generated contract | in-module |

### L5 · `apps/native/src` — the surface

| Module | Owns | Proven by |
|---|---|---|
| `app.zon` | The shortcut and menu declaration. One command-id space for both | `verify:command-space` |
| `app.native` | The markup: the notice bar and its event bindings | compiled against the model contract |
| `core.ts` | `Model`, `Msg`, `update`, `commandMsg`, `viewUnbound`. Interface state only | `core.test.ts` on the Null platform |
| `workbench.ts` | The eight destinations and the navigation rules: indices, the needs-a-document mask, the layout fractions | `workbench.test.ts` |
| `roster.ts` | The roster cursor invariant: the cursor points at a row that exists, or at −1 | `roster.test.ts` |
| `wire_json.ts` | The JSON byte mechanics for the core | `wire_json.test.ts`; `verify:wire-shapes` |
| `app_main.zig` | The shell: screens, fonts, menus, the context menu, KARA, and the theme wiring. `railTreeRow` makes a rail row: no corner, a semantic level, one indent step for each level | in-file tests; the e2e journals |
| `host_bridge.zig` | The ABI client. It adopts the borrowed projection into module-lifetime storage | e2e; `verify:native-theme-pixels` |
| `project_request.zig` | The write side: one function for each `ProjectInput` entry | in-file tests; `verify:wire-shapes` |
| `project_view.zig` | The read side: reply bytes to rows, and the Chinese labels | in-file tests |
| `snapshot.zig` | The cursor over opaque JSON, with arrays | in-file tests |
| `workbench_view.zig` | The destination names and hints, in the order of `workbench.ts` | index agreement by review |
| `document_language.zig` | Wire code to SDK syntax grammar. An unknown code falls back to plain | in-file tests |
| `corners.zig` | The corner geometry: five scales and `squared` for the absence of a corner | `verify:corner-authority` |
| `veil.zig` | The KARA veil: the gradient geometry, the chrome suffix commands, the interrupt labels | in-file tests |
| `panel_stack.zig` | The visible panel stack: the position of each layer, and `fittingDepth` for the number of layers that the window holds | in-file tests; vectors shared with `workbench.test.ts` |
| `commands.zig` | The command table: id, Chinese label, key hint | `verify:command-space` |
| `motion.zig` | The motion tokens: the durations, the easing pair, the breath loop | in-file tests |
| `material.zig` | The panel-material recipe table: surface blend, blur radius, sheen stops. The manuscript track and the rail ground do not use it | in-file tests |
| `material_paint.zig` | Recipes to pixels: plane blending, border blending, the widget apply, the sheen plan | in-file tests |
| `rail.zig` | The rail register: `band`, `dress`, and `controlTokens`. The ground is always solid. It holds no colour: each value comes from the theme table | in-file tests; `verify:native-theme-pixels` |
| `generated/` | `protocol.ts`, `protocol.zig`, `themes.zig`. Regenerate them. Do not edit them | `verify:themes-current`; protocol `--check` |

---

## The wiring graph

Each link has a name, a schema, and a gate. The table after the diagram gives
what crosses each link and what must not cross it.

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
                                     │ L0 refrain-core     │  uses no other crate
                                     └─────────────────────┘
```

| Link | What crosses | What must not cross | Pinned by |
|---|---|---|---|
| **W1 · command space** — `app.zon`, menus, and markup to `commandMsg` to `Msg` | One command id becomes one `Msg`. The keyboard and the menu use the same path | A second dispatch table | `verify:command-space` |
| **W2 · request path** — `update` to `Cmd.request` to `host_bridge` to the C ABI | ABI scalars and a bounded payload of 12,000 bytes or less | JSON that the core parsed. Non-ASCII in rodata | protocol `--check`; NS9001 |
| **W3 · response path** — Rust to `dispatch_ok` or `dispatch_err` | The revision, the status, and the projection metadata. A pointer into Rust memory for the text | The manuscript as data | `verify:bridge` |
| **W4 · view read** — Zig reads the `Model` and `host_bridge.documentView()` | Indices and counts from the Model. The borrowed projection text from the bridge | Manuscript bytes in the Model | the eight e2e journals; `verify:native-theme-pixels` |
| **W5 · project channel** — `project_request.zig` to `host/project.rs` to `Application::project` | One `ProjectInput` in. One bounded `ProjectOutput` out | A second route to a use case. A path composed in the core. A reply field that no Rust type emits | `verify:wire-shapes`, both directions |
| **W6 · document channel** — `host/document.rs` to `DocumentSurface` | `open`, `apply`, and `project` against a session id. The projection is lent back | A second document state machine | `verify:editor-kernel` |
| **W7 · store access** — use cases to `ProjectStore` | Rust calls and typed errors | SQL outside the store crate | `verify:write-path` |
| **W8 · host access** — use cases to `AgentHost` | `HostCommand` in, facts out | A Run write from another place (INV-12) | review; the journal seam |
| **W9 · the journal seam** — `AgentHost` to the `HostJournal` trait | Entities with their query columns | A database name in the host. A `ReviewTask` name in the store | two implementations |
| **W10 · generation** — build time | `protocol/host.json` to Rust, TS, Zig, and a C header. `THEMES` to `themes.zig`. `skill_doc()` to `docs/SKILL.md` | A generated file that a person edited | `--check` stages, `verify:themes-current`, `verify:skill-doc-current` |
| **W11 · frame channel** — SDK `frameMsg` to `update` to `projectionColumnsEm` | The window pixels for each frame. The column count from the typography values | A fixed `DOCUMENT_COLUMNS_EM`. A DPI guess in the view | `core.test.ts` frame cases |
| **W12 · save channel** — `document_save` to the `native-save` request to `save_ok` or `save_err` | The reply of the save as the only proof of "saved". The flight flag `savePending` | A save and keystrokes on one channel key | `core.test.ts` save-point cases |

Three traits are test seams. Each has two implementations. Do not add a trait
until a second implementation exists.

| Trait | Production | Test |
|---|---|---|
| `HostJournal` (W9) | `StoreJournal` | in-memory in the host tests |
| `ProjectPlatform` (W5) | `NativeProjectPlatform`, with the automation override for e2e | a scripted platform in the use-case tests |
| `HarnessAdapter` (L2) | the L1 argv adapter | fakes in `tests/fake_claude.rs` |

---

## One authority for each fact

Each fact below has one authority. A second copy is a defect.

| Fact | The authority | What this forbids |
|---|---|---|
| Manuscript bytes, selection, composition, undo | `DocumentSurface` in `refrain-app/src/native_document.rs` | A second document state machine |
| Block boundaries | `refrain-core/src/source_layout.rs` | A second scan in the index, the estimation, or the listing |
| Block ordinals | `refrain-core/src/searchable_block.rs` | An `Id` where a human-readable position is necessary |
| Chinese tokenisation | `refrain-core/src/chinese_index.rs` | A bigram on the index side only. This gives zero results |
| Line breaking | `refrain-core/src/typeset.rs` | A second set of rules |
| Full-width and half-width conversion | `refrain-core/src/text_width.rs` | A conversion table in the surface |
| The output of a project input | `ProjectOutput::into_opened` and `into_imported` | A catch-all match arm at each call site |
| The number of documents in a catalogue reply | The `documents` array in the reply, counted where it is drawn | A count field beside the array |
| The size and the cursor of a page | `documentTotal` and `documentCursor`, in each reply that gives them | A second spelling for each reply |
| Settings | `ConfigStore::apply`, through `Application::apply_config` | A string key-value update path |
| The persona of an agent | `refrain-core/src/persona.rs` | A Boolean "is cosplay" flag |
| The content of the mailbox | `refrain-app/src/mailbox.rs` | A second merge of proposals and arrangement |
| Error kinds | `refrain-core/src/error.rs` (`ErrorCode`) | An interface that reads an English message to decide (INV-15) |
| Artifact rejections | `refrain-core/src/agent_protocol.rs` (`ArtifactErrorCode`) | Documentation written from memory (INV-16) |
| Theme colours | The `THEMES` table in `scripts/generate-themes.ts` | A copy kept by hand. Four anchors for each theme |
| Corner geometry | `apps/native/src/corners.zig` | A radius number in another file. A bare `0` |
| Protocol layout | `apps/native/protocol/host.json` | An offset edited by hand in a generated file |
| The anchor of a projection | `projection_response` in `apps/native/host/src/document.rs` | An anchor chosen from a value instead of from the action. Each request carries the last scroll offset of the surface, thus an offset alone would have priority over each later caret and the caret could not bring the window back, and a zero offset could not be told from "I sent no offset". `applyInput` anchors on the caret; `scrollProjection` anchors on the offset at any value, zero included; every other view action keeps the block it was given. A range selection keeps the window, because the author selected text and did not ask to go somewhere |
| The scale of the virtual scroll track | `virtualBlockHeight` and `defaultViewportBlocks` in `apps/native/protocol/host.json` | A second mapping between a pixel offset and a block. Rust reads `floor(offset / virtualBlockHeight)` and stops at the last window (`total − defaultViewportBlocks`); `documentLayout` in `app_main.zig` inverts the same two constants for the leading spacer. A spacer that is placed by a proportion of the projected height is a second mapping, and only the drawing side knows that height |
| The interface font | `manuscript_font` in `apps/native/build.zig` | A second face for interface text. The SDK selects a face for each run, not for each codepoint, thus an uncovered character shows a block. `verify:font-coverage` compares the label tables against the cmap of this face |

Two more rules:

- **Discard persisted state that you cannot trust.** The undo history has the
  key `content_digest`. If the file changed outside RefRain, discard the
  history. Do not replay it on text that it does not describe.
- **The manuscript never crosses as data.** Text does not travel as JSON, as
  `number[]`, or through the bounded response channels. The bounds are 40,960
  bytes for a projection and 12,000 bytes for event text. Both bounds are in
  `apps/native/protocol/host.json`. The response lends a pointer into Rust
  memory. Project-channel replies use the same bound, thus `truncate_output`
  degrades a large reply. The handshake compares `protocol_version` and the
  capability mask, and refuses a mismatch.

---

## How a change reaches the manuscript

The product is this sequence. The author can refuse each step. Each step has a
name for its refusal, and each step gives the link that it uses.

1. **The author selects the scopes** and writes a request. (W1, W4)
2. **`context_compiler::compile`** freezes a request package: the scopes, the
   context, the contract, and a digest. (L0)
3. **The author clicks dispatch.** `dispatch.rs` follows the order.
   `AuthorizeDispatch` compares the click with the staged data, makes the Runs,
   and resolves the edges to ids. (W5, W8)
4. **`host::LaunchRun`** promotes the frozen request into the workspace of the
   Run with a rename. A Run that follows or verifies another Run must not start
   before that other Run is terminal. `upstream.rs` then adds the upstream
   artifact to the promoted copy. The frozen bytes do not change. (L2, W9)
5. **The producer runs** and writes `result.md`. `runner.rs` pumps on the
   `ReadHost` poll. It launches each authorized Run through
   `HarnessAdapter::dispatch`, observes the stream, lands the reply as
   `result.md` with an atomic rename, and completes the dispatch. An agent that
   is not connected stays `Authorized` for a manual `LaunchRun`. (L3)
6. **`app::collect_attempt`** parses the artifact against the frozen request. It
   does not parse against the claims of the artifact. It makes proposals from
   the replacements. (L3)
7. **The author decides** each proposal. `app::decide` writes the verdict to the
   append-only ledger. (W5, L1)
8. **The text changes** through the same compare-and-swap writer as any other
   commit. A countermand uses the same path. (L0, L1)

Step 2 makes step 6 correct. If the author changed a scope after the dispatch,
the proposal fails with a message. It is not applied to text that the agent did
not see.

---

## Orchestration edges

A Task can have more than one Run. An edge gives the relation between two Runs.

| Edge | Meaning | Enforced by |
|---|---|---|
| `Alternates` | The same question, with independent answers | No order. The request is frozen before any peer produces an answer (`verify:alternates-isolation`) |
| `Follows` | This Run needs the artifact of the upstream Run | It must not start before the upstream Run is terminal. The artifact enters the promoted request complete |
| `Verifies` | This Run reads the work of another Run and reports | It must not start before the subject is terminal. It must not propose edits. An artifact with replacements is refused |

`RunEdge` holds positions, because the author points at "the second one".
`ResolvedEdge` holds ids, because the ids exist only at authorization. The cycle
check runs at authorization, before any write, because the authorization is
immutable (INV-14). Both survive a crash: the edge is part of the `Run` entity
that the journal writes.

---

## Gates and verification

`bun run gate` runs each gate script on the disk. `verify:gates-run` compares the
scripts on the disk with the scripts that something invokes. It fails if a
script exists that nothing invokes.

Three evidence lanes are outside the blocking gate, because a data-layer
assertion cannot make their claims. Each lane names the one thing that it needs
from the machine that runs it, and `scripts/gate.ts` holds the three lanes in
one table:

| Lane | Needs | Command | Where it runs |
|---|---|---|---|
| `pixels` | a GPU view | `bun run evidence:pixels` | the author's machine |
| `data-performance` | a release build and a disk | `bun run evidence:data-performance` | `evidence.yml`, on all three platforms, weekly and on request |
| `window-performance` | a real window on the release platform | `bun run evidence:window-performance` | the author's machine |

`bun run evidence:performance` runs the two performance lanes together.

A lane that runs where its requirement is absent measures the runner and not the
product. A shared runner has no GPU view and no real window, thus `gate.yml`
runs no evidence lane. A red that each reader explains away is worse than a lane
that states where it can run.

State a performance budget for each platform, and give the reading that set it.
A warm catalogue refresh reads the metadata of each file. NTFS is several times
slower than ext4 for this work. One number for all platforms cannot be correct
on both.

State an interaction budget against the window that produced the reading. The
claim is "an input is on the screen by the second presented frame", thus the
budget is two present intervals of that window. Two numbers make this budget. A
fixed 16.67 ms reads a 45 Hz present path as a latency defect. One interval is
not possible for input that arrives at a random phase: the input waits for the
rest of the current frame, and then it needs the next present. Measured on this
machine: the interval p50 is 24.12 ms, and each p95 is between 1.17 and 1.75
intervals.

The present interval of this machine is not stable between runs: readings of
30.3 ms, 36.5 ms and 38.7 ms came from three runs of one binary. The budget
moves with it, thus an action near two intervals passes in one run and fails in
the next. Wait for a state with a bounded poll, never with one read of the
screen: the focus step read the screen one time and reported "the manuscript has
no focus" in two runs of five, and the next run was green.

Run these commands in this order. Run all of them for each change.

```sh
bun run scriptc:build    # the tier A gates run the compiled artifact
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
bun run gate
```

`bun run scriptc:build` must run first. The tier A gates execute the compiled
binary. A missing artifact fails the gate. The gate does not use the interpreter
instead.

**Injection-verify each gate.** Break the thing that the gate guards. See the
gate fail. Restore the thing. See the gate pass. A gate that never failed proves
nothing. See [CONTRIBUTING.md](CONTRIBUTING.md).

**A gate that cannot run also proves nothing.** A check can stay in the list and
be dead: it can read a path that only one platform has, it can set an
environment variable that no code reads, or it can click a control that the
surface removed. Run each evidence lane on the release platform.

### The four workflows

Each workflow answers one question. A workflow that answers no question, or that
asks a machine for something the machine does not have, comes out.

| Workflow | The question | When |
|---|---|---|
| `gate.yml` | Does this commit pass every blocking gate on Linux, Windows and macOS? | each push and each pull request |
| `evidence.yml` | Does the data layer stay inside the budget that each platform states? | weekly, on request, and when a budget file changes |
| `ime-gate.yml` | Does a real Windows input method reach the manuscript? | weekly and on request, while the lane is under construction (P7) |
| `release.yml` | Does this tag point at a green commit, and does the archive read back? | a tag that starts with `v` |

Two rules hold this shape:

- **A release starts from a green commit.** `release.yml` asks the Actions API
  for a `gate.yml` run that succeeded on the tagged commit and refuses to build
  without one. Before this, a tag on a red commit produced a published asset:
  the release workflow checked the version surfaces and the archive, and nothing
  asked whether the code passes.
- **One reader for each fact.** `gate.yml` runs `bun test` and `bun run check:ts`
  on three platforms, thus no other workflow repeats them.

**A red gate can be the environment.** Before you call a red result a defect,
run the same gate on the base commit with no local changes. The same failure
text shows that the machine is red, not the change. Assert a fact that must be
true on all machines with a test that needs no window.

### Eight journals, one for each destination

A session journal is a recorded run of the product. It holds each event, each
host answer, and a fingerprint of the accessibility tree for each frame.

There is one journal for each destination: manuscript, files, review, dispatch,
mailbox, connections, history, and settings. `scripts/native-journals.ts` is
their only authority. It holds the steps, the destination index, and the verify
mode. The table has the type `Record<JournalName, JournalPlan>`. A destination
with no journal is a type error.

The two halves run in different worlds:

- **Recording** (`bun run e2e:record`) drives a real window on the release
  platform. It clicks what an author clicks. It waits for the screen to show a
  text. It does not sleep for a fixed time. A step that finds no control fails
  at that step.
- **Replay** (`bun run e2e:journals`) runs headless on the null platform. The
  journal is the world. Eight destinations replay in less than two seconds and
  need no display. CI runs this command. The report goes to
  `target/e2e-evidence/journals.json`.

Use this lane to judge a surface migration. A rewritten core must consume the
same host answers in the same order. For the journals that verify, it must also
draw a tree with the same fingerprint. Three journals verify today. The other
five give M8 as the reason.

A journal also states which protocol it was recorded under. Replay feeds the
recorded answers to the core, and the core compares each answer against the
`PROTOCOL_VERSION` that is compiled into it. A journal from another protocol
makes each answer a broken contract, and the fingerprints still agree, thus the
lane reports green while it judges nothing. Measured at protocol 4 → 5: eight of
eight replayed green with every host answer refused. `recordedProtocolVersions`
now reads the version out of the file, and a stale journal fails by name.
Re-record with `bun run e2e:record` after a protocol change.

---

## Open items

Each item gives the gap, the modules that wait at one end, and the work that
closes it. A ◐ or ○ in the function matrix points here.

| # | The gap | What waits | The work |
|---|---|---|---|
| **M6** | **The PDF screen and the diagram screen do not exist.** The facts exist: `block_shape::Table` knows the shape of a table, and `ingest/pdf` extracts the text | the domain facts | One screen for PDF and one for diagrams. A table stays aligned text: a caret offset is a byte offset, and a table adds a second coordinate system. An imported PDF is read-only, because `.refrain-source/` is never written |
| **M7** | **Icons have no consumer.** `icons.rs` normalises and content-addresses an image. No module above the store reads it | `icons.rs`, `tests/icons.rs` | The surface that offers and shows the icon |
| **M8** | **Replay cannot verify a frame that holds the manuscript.** The projection is in the module buffer of `host_bridge`, not in the Model. The replayer feeds the host answers to the core, and the view has no path to the text. Measured: the three journals that open no document verify all 28 fingerprint checkpoints. Each journal that opens a document differs from the frame after the click on the document row | the eight journals and the tier table in `scripts/native-journals.ts` | Move the projection into the Model. Measure the cost first: approximately 11.5 KiB for each frame through the core. Then change `tier` in the one table |

Wired, but with no signature from a real machine: IME composition on Windows and
macOS. `SetComposition`, `CommitComposition`, and `CancelComposition` exist, and
`verify:native-ime` exists.

Closed in this version: KARA events and the veil, typography in the projection,
material drafts, the cross-document jump, anchored ranges (M1 to M5); the
producer runner (M9); the rail colour register (M12); the caret half of the
projection anchor and its wheel half (M13); the interface font coverage (M14);
the panel material against the rail register (M15).

---

## Planned changes

Each item gives the decision, the alternative that was refused, and the
observation that reverses the decision. No code has moved. Judge the work
against these statements.

### The interface state leaves TypeScript

**The decision.** `Model`, `Msg`, and `update` move from `core.ts` to the Zig
shell that draws the pixels.

**The reason.** This TypeScript compiles through a restricted subset. The subset
has no JSON parser, no `TextEncoder`, no `Number()`, and fixed-length strings.
Thus the surface reads each fact from a reply with a scan for a quoted byte
pattern. A pattern that no Rust type emits gives zero, and each test stays
green. Zig reads the same replies through `snapshot.zig`, where a field that
does not exist is a compile error.

**The refused alternative.** Keep the TypeScript lane and correct it in place.
This is the cheaper move, and it is the fallback if the spike fails. It is not
the destination, because the two lanes have different semantics: `Array.isArray`
answers false for a tuple in the compiled core. A lane with unit tests on a
different engine than the product is not a tested lane.

**What reverses the decision.** The Zig shell shows a defect of the same class —
a defect that passes each test and fails only in a real window. The spike must
end with a recorded journal that replays `--verify` green through a real window.

**What must not follow.** The domain does not move. `refrain-core`,
`refrain-store`, `refrain-host`, and `refrain-app` stay in Rust. "Zig core"
means the `Model`, `Msg`, and `update` of the shell only.

### The bridge leaves opaque JSON for typed rows

**The decision.** The reply channel carries rows generated from
`protocol/host.json`: `repr(C)` structs in Rust and matching declarations in
Zig. Neither side parses.

**What this removes.** Today one reply shape has three readers: serde in Rust,
the byte patterns in `core.ts`, and the cursor in `snapshot.zig`. Nothing
reports a difference between them. `verify:wire-shapes` exists because there are
three readers. With one reader the gate is not necessary.

**The refused alternative.** A JSON parser in the surface. This makes the
reading correct, but it keeps three authorities. The difference between the
authorities is the defect class.

**What reverses the decision.** The row structs become a second place for
product vocabulary. If a screen text or a paging rule moves into the schema, the
shape moved the problem. Rows carry only what is drawn. Paging and truncation
stay with `truncate_output`.

---

## Glossary

Use these words. SPEC §2 requires one word for each concept.
`verify:one-word-per-concept` enforces this in the modules of each concept.

### The manuscript

| Term | Meaning |
|---|---|
| **Root** | A folder or a single file that the author adopted. The unit of a project |
| **Source Backup** | `.refrain-source/`. The files at the time of adoption. Never written |
| **Document** | One text file that the author writes. The file on the disk is the only original |
| **DocumentFormat** | The type of the bytes of a document. Decided one time from the extension. It selects the block scan, the index preprocessing, and the grammar |
| **Block** | One structural unit of a document: a paragraph, a heading, a list, a table, or a fence |
| **Ordinal** | The position of a block in its document. An agent quotes it to get the block |
| **Revision** | The version counter of a document. A proposal gives the revision that it used |

### Search

| Term | Meaning |
|---|---|
| **SearchableBlock** | A block as `refrain-core` sees it: borrowed from the source text |
| **IndexedBlock** | A block as `refrain-store` returns it: owned, with bm25 |
| **DisclosedBlock** | A block as the agent receives it: owned, with a readable location |
| **SearchHit** | A hit for the interface |
| **ScoredHit** | A hit during the ranking, borrowed from the index |
| **Precision** | `Exact` or `Loose`. Exact falls back to Loose when it finds nothing |

### Agents

| Term | Meaning |
|---|---|
| **Harness** | A local executable that runs an agent. Never a remote service |
| **Task** | One question from the author, with its Runs |
| **Run** | One attempt by one agent against one frozen request |
| **RunEdge**, **ResolvedEdge** | The relation between two Runs: by position, then by id |
| **Dispatch package** | The frozen bytes: request, context, contract, digest |
| **Material** | A reference document for this round. It enters the context picker only |
| **MaterialListing** | The data in a request: path, title, headings, an excerpt, size, digest, disclosure. Not the text |
| **Disclosure** | The permission for one material: `OutlineOnly`, `Retrievable`, or `Full` |
| **Artifact** | The output of a producer: one `<agent-result>` element |
| **Proposal** | A replacement that still matches the frozen text, before a human decision |
| **Review Slice** | One reviewable piece of a proposal. Its ordinal counts slices in a proposal, not blocks in a document |
| **Verdict Ledger** | The record of each decision: accepted, accepted with edits, or sent back |
| **Mailbox** | The proposals of a Root with the arrangement of the author, in one screen |
| **Countermand** | The reverse verdict on a merged proposal |
| **Persona** | The identity of an agent: `Work` or `Cosplay` |

### The surface

| Term | Meaning |
|---|---|
| **Destination** | One of the eight places of the workbench. An index in the Model, not eight Booleans |
| **Roster** | A list of rows with a cursor. The cursor points at a row that exists, or at −1 |
| **Projection** | The bounded window of blocks that the bridge lends to the surface, with the line starts |
| **Document session** | One open document on the document channel, with an id from the bridge |
| **Layer** | One panel in the rail. `panel_stack.zig` gives the position and the count |
| **Stage** | The manuscript column |

---

## Where to look when something is wrong

| Symptom | Start here |
|---|---|
| The text draws incorrectly, the cursor moves, or the selection breaks | `refrain-app/src/native_document.rs` |
| A line breaks at the wrong position | `refrain-core/src/typeset.rs` |
| A block boundary is wrong | `refrain-core/src/source_layout.rs` |
| The estimated height of a block is wrong | `refrain-core/src/block_shape.rs` |
| A shortcut does nothing | `apps/native/app.zon` declares it. `core.ts::commandMsg` maps it |
| A menu item and its shortcut do not agree | Read `verify:command-space`. Both use W1 |
| Search returns nothing, or the wrong order | `refrain-store/src/project/search.rs`, `refrain-core/src/search_rank.rs`, `chinese_index.rs` |
| A Chinese word of two characters finds nothing | `refrain-core/src/chinese_index.rs` |
| A file did not save, or saved to the wrong place | `refrain-store/src/atomic.rs`, `root.rs` |
| A crash left a `.writing` file | `refrain-store/src/atomic.rs` |
| An agent reply was rejected | `refrain-core/src/agent_protocol.rs` |
| A request carried the wrong context | `refrain-core/src/context_compiler.rs` |
| A Run started too early, or did not start | `refrain-host/src/host.rs` |
| A dispatched Run does not advance | `refrain-app/src/runner.rs`. Check the `IN_FLIGHT_*` counts in `core.ts` |
| A downstream Run did not get the upstream work | `refrain-app/src/upstream.rs`, `refrain-core/src/upstream_work.rs` |
| A proposal could not be applied | `refrain-app/src/decide.rs`, `refrain-core/src/manuscript/review.rs` |
| A countermand reverted the wrong text | `refrain-app/src/decide.rs` |
| A mailbox entry is in the wrong box | `refrain-app/src/mailbox.rs` |
| Orchestration state was lost | `refrain-app/src/journal.rs` |
| A Run cannot stop although a process runs | `refrain-app/src/cancel.rs` |
| History does not roll back to a step | `refrain-app/src/native_document.rs`, `refrain-store/src/history.rs` |
| An annotation lost its anchor | `refrain-store/src/annotations.rs` |
| A colour is wrong, or a theme looks flat | `apps/native/src/generated/themes.zig` |
| A corner has the wrong shape | `apps/native/src/corners.zig` |
| The rail loses its colour, or a material stops the drawing | `apps/native/src/rail.zig` and `material.zig`. The rail ground takes no material |
| An input reaches the screen late | `verify:native-document-performance`. Compare the p95 with the present interval in the same report, not with 16.67 ms |
| A wheel does not move the window, or the scrollbar disagrees with the text | `projection_response` chooses the anchor from the action; `documentLayout` in `apps/native/src/app_main.zig` places the spacers on the same scale |
| A roster cursor points at a row that is gone | `apps/native/src/roster.ts` |
| A character draws as a block | `verify:font-coverage`, then `manuscript_font` in `apps/native/build.zig` |
| A panel covers the manuscript, or the stage is too small | `apps/native/src/panel_stack.zig`, `layeredBody` in `app_main.zig` |
| A screen shows old facts after an action | The reply of the action is the new view. A second read means that the first reply was wrong |
| The protocol handshake fails | `apps/native/host/src/contract.rs`, `protocol/host.json` |

---

## Technology

`Cargo.toml` and `package.json` hold the exact versions. This table gives the
projects and the reason for each one.

| | |
|---|---|
| **Languages** | [Rust](https://rust-lang.org) for the domain. [Zig](https://ziglang.org) for the platform and the drawing. A restricted [TypeScript](https://www.typescriptlang.org) subset for the interface state |
| **Application shell** | [Native SDK](https://native-sdk.dev) `@native-sdk/cli` 0.9.0, with an increment in `patches/`. Native rendering. No WebView and no JavaScript runtime in the binary |
| **Surface** | `.native` markup compiled against the model contract. [Biome](https://biomejs.dev) formats the TypeScript |
| **Build tooling** | [ScriptC](https://github.com/vercel-labs/scriptc) compiles the tier A gates and the release scripts to binaries. [Bun](https://bun.sh) runs the other scripts. Neither ships |
| **Storage** | [SQLite](https://sqlite.org) through [rusqlite](https://github.com/rusqlite/rusqlite), FTS5 `unicode61`, and a bigram tokeniser in the application |
| **Config format** | [TOML](https://toml.io). A real format needs a real parser |
| **Hashing** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) |
| **Ids** | [UUID](https://github.com/uuid-rs/uuid), version 7 |
| **Serialisation** | [Serde](https://serde.rs) and [specta](https://github.com/specta-rs/specta). One schema (`apps/native/protocol/host.json`) generates Rust, TypeScript, Zig, and a C header |
| **Scanning** | [memchr](https://github.com/BurntSushi/memchr) |
| **Errors** | [thiserror](https://github.com/dtolnay/thiserror) |
| **Filesystem walk** | [ignore](https://github.com/BurntSushi/ripgrep), the traversal of ripgrep, and [rayon](https://github.com/rayon-rs/rayon) |
| **Recycle bin** | [trash](https://github.com/Byron/trash-rs), the only cross-platform route to a recoverable delete |
| **Icons** | [usvg](https://github.com/linebender/resvg), resvg, and tiny-skia for SVG. [image](https://github.com/image-rs/image) for PNG. Judged by content, not by the accept string of the picker |
| **Material ingestion** | [lopdf](https://github.com/J-F-Liu/lopdf) for PDF, [zip](https://github.com/zip-rs/zip2) for the office formats, [html5gum](https://github.com/untitaker/html5gum) for HTML. All local |
| **Dialogs and directories** | [rfd](https://github.com/PolyMeilex/rfd) and [directories](https://github.com/dirs-dev/directories-rs) |
| **Process signals** | [nix](https://github.com/nix-rust/nix) on Unix, to cancel a producer tree |
| **Fonts** | Noto Sans SC (variable) for the interface and the manuscript, Antic Didone for Latin, Zen Kaku Gothic New for Japanese. The SDK selects one face for each run |

### Two decisions with measurements

**RefRain breaks its own lines.** A browser or the SDK can wrap text, but neither
compresses a full-width punctuation mark at the end of a line, and neither hangs
one in the margin. CJK typesetting needs both. `refrain_core::typeset` receives a
string and a preset and returns break offsets. The projection carries the offsets
across the bridge, and Zig draws them. Thus no byte enters the text, and a caret
offset stays a byte offset. There are two presets, because the rules conflict:
Simplified Chinese compresses the mark by half an em (GB/T 15834 §5.1.10), and
Japanese keeps the space and hangs the mark (JLREQ §3.1.9). The breaker is
greedy, because Chinese breaks at almost each character: greedy gives the
paragraph optimum, and a dynamic program costs 960 times more. The optimizer runs
only for a paragraph with a long unbreakable run.

**The index uses bigrams.** Measured on 22,410 files (252 MB):

- FTS5 `trigram` was refused. It indexes tokens of three characters or more, thus
  a two-character Chinese word returns zero results. `bm25()` also returns
  `-0.0000` for each row, thus the ranking is dead.
- jieba with a second index was refused. The invented names of an author are in
  no dictionary, and a second index store adds a failure class.
- `unicode61` with an application-level bigram was selected. Single characters
  stay as their own tokens. The index becomes 1.96 times larger.
- Terms are joined with `AND`. `OR` returned 500 rows of noise for a word that
  does not exist. `NEAR` returned zero for a phrase that does exist. `AND`
  reduced the noise from 500 rows to 21 rows, lost no true answer, and ran 6.7
  times faster.

### The carried SDK increment

`patches/` is not a private fork. It is an increment on `@native-sdk/cli` 0.9.0.
Each hunk answers three questions: what RefRain cannot do without it, why the SDK
cannot supply it today, and how it leaves. Delete a hunk that cannot answer all
three at the next upgrade.

| The increment | Why RefRain carries it | Exit |
|---|---|---|
| **The typeset breaks** — `hard_breaks` on the text layout | `refrain_core::typeset` is the line-breaking authority. The SDK breaks at space and tab only, and a Chinese paragraph has neither | Offer upstream as a layout input |
| **Per-widget text size and line height** | The measure of the manuscript comes from the typography settings of the author. The token ladder cannot state this for each widget | The same pull request as the breaks |
| **The caret rectangle** — `text_caret_bounds` and `TextInputGeometrySnapshot` | An IME candidate window must sit at the caret. Without this the platform host estimates the position, and shaped CJK text moves the caret in the frame | Offer upstream. The runtime already has this geometry |
| **Change-aware dispatch** — `update_fx_changed`, `dispatchChanged`, `view_state_revision` | The projection is in the buffer of the bridge, not in the Model. A host callback can change what a view reads without a change to the model root | This is the ground of M8. It becomes smaller when the projection moves into the Model |
| **A TypeScript core under a hand-written entry** — `appTsCoreStage` | `addAppArtifacts` stages a TS core only when it also owns `src/main.zig`. RefRain draws its own shell in `app_main.zig` | Offer upstream as an `AppOptions` field. It dies with the TypeScript lane |
| **Declaration-only type staging** — `compiler_typecheck.mjs` | The `events.d.ts` edge resolves to the `.ts` implementation, thus the analyzer typechecks SDK sources under the stricter settings of RefRain | An upstream defect. The export map of the `.d.ts` is one half of the correction |
| **The disabled ink of the row register** — `rowForegroundColor` | The rail is a second surface register beside the paper. `ControlVisualTokens.disabled_foreground` documents this ink, and the button ladder uses it, but the row ladder used the global `text_muted`. On four of seven themes that ink reads at \|Lc\| 8 to 20 against the rail | Offer upstream as a defect correction. Delete it on the day it lands |
| **Windows semantic-analysis object** — `build/app.zig` | The Zig COFF backend cannot merge several archives into one object, and this application links a Rust staticlib. Cost: on Windows, `zig build test` does not force semantic analysis of the app module | A Zig backend limit. Test again at each Zig release |

---

## Related documents

- [README.md](../README.md) — what RefRain is, and how to install it
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose a change
- [AGENTS.md](AGENTS.md) — the working discipline for agents in this repository
- [SKILL.md](SKILL.md) — the agent protocol (generated)
- [LICENSE](../LICENSE) — MPL 2.0
