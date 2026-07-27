# SPEC — Design Baseline

> v0.1.5 · 2026-07-27 · This file is the authoritative design baseline.
> When an implementation disagrees with this document, change the implementation.
> Append a Changelog line for every edit. Never rewrite history silently.

## Changelog

- 2026-07-27 v0.1.6 — Root permission moved to the main process. Only a picker, drop, create, OS-open event, or a permit already stored in main-owned application state may authorize a Root; renderer localStorage only remembers presentation. Each permit pins the canonical path and filesystem identity, so retargeting a symlink revokes mutation authority. Source Backup cannot receive a permit.

- 2026-07-27 v0.1.6 — Closed Q22/Q23. A single-file Root owns the adjacent `.<filename>.refrain/` companion: mutable project state remains under `.refrain/`, the immutable original under `.refrain-source/`, and no neighbouring manuscript is adopted. A pre-existing unowned companion or symlink is refused. A failed folder-Root Source Backup remains an explicit Notice but does not remove editing access; the author keeps control of an otherwise usable manuscript.

- 2026-07-27 v0.1.5 — Wired the Source Backup into folder-Root adoption. An existing manuscript is copied before project state is opened; an empty Root records that it was empty without creating an empty `.refrain-source`, so text authored later cannot become a false original after restart. Q23 records the unresolved policy for a backup RefRain cannot take.
- 2026-07-27 v0.1.5 — Source fidelity (§1.3, INV-5) and bounded alignment (INV-8). A manuscript opened and saved with no edit lost twelve bytes of a hundred and eighty-six: `trim()` on load deleted the ideographic indent, a blank line inside a fence split one code block into two, and rebuilding the file from block text alone flattened consecutive blank lines. Three copies of the block split — `core`, the main process, the renderer — converged on one authority in `roundtrip.ts`, which keeps the original bytes and each block's range in them. The renderer learned that composition exists: a save asked for mid-composition is deferred rather than writing an uncommitted candidate to disk. `edits.ts` and `review.ts` now share `align.ts`, which segments at unchanged runs and refuses to allocate past a table budget; a 40,000-block save that threw `RangeError: Out of memory` now completes, and 100,000 blocks complete in every mutation shape.
- 2026-07-27 v0.1.5 — Rewrote every claim this file made about a thing that does not exist. §4 no longer lists ProseMirror as installed; §5.1 separates what is on disk from what is planned, and drops `ui/`, an empty package whose `exports` pointed at a file nobody had written; §5.2 marks rules 4, 5, 6, and 8 as commitments rather than descriptions; §11 stops saying the IME gate has not landed, and says instead that it has landed without a latch. Q9 settles the eight themes and how day and night relate, Q10 the three typeface slots and the faces that fill them, Q11 whether a subdirectory's Markdown is material or a chapter.
- 2026-07-27 v0.1.5 — Author saves now advance the main process's canonical Text Head instead of rebuilding paragraph IDs from strings at each IPC call. Unchanged blocks keep their IDs across removals and later disjoint insertions. Restoring a removed block is an insertion Text Change inside a compensating Text Action; a vanished lineage boundary fails closed instead of appending the block elsewhere.
- 2026-07-26 v0.1.3 — The file layer (§13) and display matching (§14). The Claude Code adapter relays its four reported token counts without deriving a price or a synthetic total. The Host reclaims launched runs, closing BUG-1. Q5 reopened because 289px was a measurement fault. `packages/fs` is the only package carrying Rust and a platform binary; releases build it on Windows x64, Linux x64, and macOS arm64/x64 before packaging. Motion and hairlines derive from the panel's refresh rate and scale factor. Q8 opened for the cross-volume trash failure measured on Linux.
- 2026-07-26 v0.1.2 — Renamed RefRain. Cool default palette (§4.4). Edit record, multi-root workspace, command palette as sole entrance, eighteen typographic controls, bundled OFL faces. Q5 opened for the header alignment defect.
- 2026-07-26 v0.1.1 — M0 landed. Toolchain findings recorded in §4.3; prototype absorbed into `core`; Q1 closed.
- 2026-07-26 v0.1.0 — First draft: form, domain language, module boundaries, Verdict Ledger protocol, harness tiers, M0 gates.

---

## 0 · For the implementer

This file is self-contained. You need no conversation history to pick up the work.

1. Read §1–§3 (product and domain language), then §4–§6 (stack and architecture), then execute §11 in order.
2. Do not invent decisions this document omits. Append them to §12 and continue with what you can determine.
3. Nothing on the §1.3 non-goals list gets built.
4. A milestone is done when its acceptance commands are green — not when the code looks finished.

---

## 1 · Product

### 1.1 One sentence

A local writing workbench that turns every agent edit into a reviewable, attributable, contestable proposal — and leaves the manuscript in human hands.

### 1.2 The core idea: the Verdict Ledger

Every human judgment about agent output — accept, reject, accept-with-changes, and **why** — is first-class data: persisted, searchable, replayable, accumulating.

Existing tools treat a verdict as a transient UI event. Click accept, and the reasoning evaporates. Persisting it produces three things nothing else offers:

- **Reply.** The verdict becomes part of the next prompt. The agent learns why the last draft was rejected.
- **Taste.** Accumulated verdicts are a sample of this author's judgment — no training required, only retrieval.
- **Audit.** A finished work can show which sentence a human wrote, which an agent proposed, and which an agent proposed and a human revised.

Editors go stale. Harnesses turn over yearly. The ledger does neither. This is the project's moat.

### 1.3 Non-goals

Building any of these is a defect:

- No models, API keys, accounts, or telemetry inside the app. **The app process makes no outbound network requests.** Every model call happens inside the user's own harness.
- No YOLO mode, auto-accept, auto-merge, background merge, or agent self-adjudication. No setting, CLI flag, plugin, or agent may bypass a human click.
- No billing math. No prices, no cost estimates. Report token counts exactly as the harness reports them; when it reports nothing, display unknown.
- Never silently reduce runs the user already authorized in order to save tokens.
- Not in v1: multi-user collaboration, remote agents, cloud sync, reference libraries, multi-format preview, vector search, export pipelines, plugin loader.

### 1.4 Three axioms, in priority order

1. **Files are truth.** Markdown on disk, readable and editable and git-trackable without this application.
2. **Proposals are data.** An agent's edit is a reviewable object, not an accomplished fact.
3. **Verdicts are replies.** Accept, reject, revise, annotate — all serialized back to the agent.

---

## 2 · Domain language

Implementation, tests, and UI strings use these terms. **One concept, one word. No synonyms.**

### 2.1 Manuscript and history

| Term | Definition |
|---|---|
| **Workspace** | Several roots open at once. A root is a folder of Markdown, or a single file opened without adopting its neighbours |
| **Project** | A work, its chapters, its rules, and its collaboration record — one local scope |
| **Source Backup** | The immutable original kept when a project is created from existing files. Never written to |
| **Canonical Text** | The text the human currently endorses, represented by the current Text Head |
| **Text Action** | One atomic manuscript change the user performed or explicitly committed, producing a new Text Head. Agent output is never a Text Action |
| **Text Change** | An independently locatable item inside a Text Action, carrying a stable ID, range lineage, and before/after text |
| **Text Head** | The immutable manuscript state produced by a completed Text Action. Exactly one is current |
| **Revision** | A Text Head pinned at a collaboration boundary. Runs, Proposals, and Decision Batches reference it |
| **Selective Undo** | A compensating Text Action appended to the current head, removing only the surviving effects of one past action. It does not move a history pointer |

### 2.2 Collaboration and adjudication

| Term | Definition |
|---|---|
| **Review Task** | A collaboration request requiring an agent run: Context Scope, Edit Scopes, prompt |
| **Context Scope** | What a run may read. Readable is not writable |
| **Edit Scope** | A manuscript slot a run may replace. One Review Task may carry **several disjoint** Edit Scopes |
| **Run** | One execution record by one agent for one Review Task |
| **Task Workspace** | A run's exclusive write area. The app never deletes it automatically |
| **Result Artifact** | The thin Markdown a run writes atomically on completion, bound to its Edit Scopes |
| **Proposal** | An immutable edit candidate frozen from a validated Result Artifact, referencing a run, a baseline Revision, and one Edit Scope |
| **Review Slice** | A deterministic diff fragment between a Proposal's before and after text |
| **Verdict** | A human judgment on one Review Slice or a whole Proposal. The ledger's unit |
| **Decision Batch** | A set of Verdicts committed as a single atomic Text Action |
| **Edit** | One addressable change the author made: a replacement, an insertion, or a removal, carrying before-text, after-text, and optionally the author's own note. Revertible on its own and serialisable to an agent |

### 2.3 Agents and harnesses

| Term | Definition |
|---|---|
| **Agent** | A collaborator identified by one exclusive Session and one immutable Runtime Binding |
| **Session** | An agent's exclusive native context and event lineage |
| **Runtime Binding** | Harness, model, and reasoning effort, locked at agent creation. Runs inherit; they never override |
| **Harness** | The software environment running the model and its tool loop |
| **Harness Adapter** | The implementation connecting Agent Host to one harness |
| **Agent Host** | The local process maintaining adapters, agents, sessions, runs, and state |
| **Automation Grant** | A revocable permission for one specific agent to continue a pre-declared orchestration inside one already-sent Review Task |

---

## 3 · Rules that cannot be violated

### 3.1 Manuscript and human adjudication

1. There is exactly one manuscript: the text the human currently endorses.
2. Agents have no write access to it. They write only their own Task Workspace.
3. Proposals are frozen only from validated Result Artifacts. A Proposal never changes the manuscript by itself.
4. Agent text reaches the manuscript through exactly two paths: the user clicks **merge as-is**, or the user edits the text and clicks **merge revised**.
5. Comment-only results enter the review window without manufacturing empty Proposals.

### 3.2 Manual dispatch and batching

The user selects a range, writes a prompt, picks an agent, and adds it to a pending queue. The queue accumulates across chapters and agents, then goes out on **one click with one consolidated manifest**.

Idle time, cursor movement, and autosave never create a Review Task.

Before sending, per agent: run count, locked harness, locked model (tagged whether verified), Edit Scope ranges, prompt text. **No prices. No cost estimates.**

### 3.3 Token counts are reported, not computed

Token figures come from the harness, in three states:

- **actual** — reported by the harness
- **estimated** — computed locally, method stated
- **unknown** — unavailable

Never present an estimate as fact. Never present unknown as zero.

### 3.4 Compaction is labeled, not fatal

Most harnesses truncate or compact context. When compaction occurs, mark the session **lineage-unverifiable** and display that plainly. Whether to start a fresh agent is the user's call.

We reject the "compaction permanently freezes the agent" rule: it stages a funeral several times a day and excludes most harnesses from the compatibility list.

### 3.5 Drifted scopes are flagged, not cancelled

If an Edit Scope's text changes while queued, mark that slot `drifted` and surface it in the send manifest. The user decides whether to drop the slot or re-read it. **Cancellation belongs to the human.**

---

## 4 · Stack

| Component | Version | Note |
|---|---|---|
| TypeScript | 7.0.2, strict | Native compiler; `tsc` runs on save |
| Bun | 1.3.14 | Runtime, package manager, test runner, SQLite. Rust-implemented core |
| Electron | 43.2.0 | Chromium 150.0.7871.129. Pinned and revertible |
| Svelte | 5.56.x (runes) | Shell UI only |
| ProseMirror | — | **Planned for v0.2, not installed.** The manuscript is a `contenteditable` driven directly |
| Biome | 2.5.5 | Formatter and linter, one config |

This table said `ProseMirror 1.42.x` for three releases while `grep prosemirror`
returned nothing. That is worse than an omission: the IME gate's test page is a
ProseMirror page, so the most expensive evidence this project owns — a Windows
machine, Microsoft Pinyin, four shells, real `SendInput` typing — was guarding
an editor that does not ship. §5.2 rule 5 states the rule the editor must meet;
until `packages/editor` exists, the shipped surface has not been measured
against it.

### 4.1 Why Electron, not Tauri

The criterion is not which framework is better. It is **who controls the engine version**.

A Chinese IME regression exists between Chromium 149.0.7827.54 and .103: `contenteditable` swallows the first composition character, and Chinese punctuation requires two keypresses.

- [tauri#15436](https://github.com/tauri-apps/tauri/issues/15436) — on Windows, first focus on a ProseMirror `contenteditable` containing existing text deadlocks TSF. Workarounds in both Rust and JS failed.
- [WebView2Feedback#5625](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5625) — unfixed on WebView2 149 Evergreen; JS-layer mitigation ineffective.
- [web-text#1](https://github.com/ale-160/web-text/issues/1) — bisected to that exact range using two Edge builds.

WebView2 Evergreen updates on Microsoft's schedule; an app cannot pin or revert it. Electron ships Chromium inside the bundle, so **the project decides when to take a new engine**.

A measured test (four shells × four criteria, Microsoft Pinyin driven by `SendInput`) found no reproduction on current engines. Its author stated the confidence boundary: machine cadence is not human cadence, and fixed-interval keystrokes cannot surface TSF races that appear only under irregular typing. Hence the conclusion is **relax the pin, keep the gate** — not remove the gate.

### 4.2 Why Rust stops at the file boundary

The measured file workload justified one native module: walking and searching 20,000 paths, natural sorting, and recoverable deletion through three operating systems. `packages/fs` owns that work and exposes it through N-API, the ABI shared by Electron, Node, and Bun.

Domain logic remains TypeScript. Text Actions, Proposals, Verdicts, and harness contracts change for semantic reasons, not throughput, and their contributors work in the TypeScript ecosystem. Rust may enter only behind a measured boundary with its own cross-platform tests; it does not spread upward into `core`, `agent`, the editor, or the shell.

### 4.3 Colour: eight palettes, four anchors each

An earlier draft of this section described three palettes — 雨, 楮, 夜 — and
argued for a cool default ground near hue 235. None of those three exist, and
the reasoning inverted: the default 濤 is warm paper (hue 87.5) carrying cool
ink (hue 258.2). The section is rewritten against what ships rather than
patched, because every claim in it had drifted.

**Eight palettes, grouped by hour rather than by polarity.** Day: 濤 tou
(default), 霞 kasumi, 枯 kare, 林 hayashi, 瓷 seiji. Night: 墨 sumi, 幽 yu,
時雨 shigure. Night is not day inverted — each is drawn from its own
reference, so eight themes means eight, not four with a switch. The light/dark
command crosses between the two groups and remembers where the writer was on
each side (Q9).

**Four anchors, everything else derived.** A theme states `paper`, `ink`,
`seal`, `agent`; `docs/theme-tokens.ts` derives some forty tokens from them
and refuses to emit the stylesheet when any APCA threshold fails. Adding a
theme is four colours, not forty. `themes.css` is generated and must not be
hand-edited.

**Ink and paper lean apart, not together.** Matching the ink to the paper's
hue produces a tinted PDF: technically harmonious, materially dead. 濤 puts
cool ink on warm paper; 瓷 puts a colder ink on a green-leaning ground. Ink is
stated as solid values, never as a tint of the ground — dilute it with opacity
and it becomes grey, which is how an earlier "warm ink" arrived on screen as
no ink at all.

**Chroma is the difference between a sheet and a callout.** Day papers sit
between chroma 0.006 and 0.022. At 0.034 a viewport of it reads as an
information panel; the character of a palette comes from hue, not saturation.

**Lightness moves; hue and chroma hold.** Everything is stated in OKLCH, which
is what lets a night theme read as a lamp on paper rather than as an inverted
screen — and what lets the lit corner be the paper's own hue raised along L
rather than a wash of white laid over it.


### 4.4 Toolchain findings, measured

M0 required proving the TypeScript 7 chain rather than assuming it. Three findings changed the build:

1. **The binary is `tsc`, not `tsgo`.** `tsgo` was the name under `@typescript/native-preview`; 7.0.2 ships the native compiler as `tsc`. `node_modules/typescript/lib/tsc.js` is a thin Node shim that `execve`s the native executable.
2. **Piping a gate destroys its exit code.** `tsc --noEmit | head` exits 0 with type errors present. CI runs every gate unpiped, and `scripts/verify-gate.ts` feeds the typechecker code that must be rejected — a gate that cannot fail is worse than no gate.
3. **`allowImportingTsExtensions` is mandatory.** Bun executes `.ts` directly, so imports carry the extension; without this flag TS 7 rejects every internal import.
4. **`svelte-check` 4.7.3 crashes under TS 7**, reaching for `useCaseSensitiveFileNames` on an internal API that no longer exists. `apps/desktop/scripts/check-svelte.ts` compiles every component with Svelte's own compiler instead, which is the authority on its syntax anyway.
5. **Biome lints only a Svelte file's `<script>` block**, so template references read as unused variables. Biome formats `.svelte`; the compiler check owns its linting.
6. **Electron loads CommonJS**, so `main` and `preload` are bundled to `.cjs` — under `"type": "module"` a `.js` CJS bundle fails at launch, which no unit test reaches. `apps/desktop/test/smoke.test.ts` asserts the build shape, and CI launches the real binary with `--smoke` and requires the window to report a finished load.
7. **`core` runs in two runtimes with disjoint SQLite builtins.** Bun 1.3 ships `bun:sqlite` and lacks `node:sqlite`; Electron's Node ships the reverse. A direct import of either passes every test in one runtime and throws at launch in the other — which is how `bun:sqlite` reached a release build and failed the launch gate. `packages/core/src/sqlite.ts` selects at runtime, `packages/core/test/runtime.test.ts` forbids a top-level `bun:` import anywhere in `core`, and `make.sh` exercises the Node branch with a real round trip.
8. **electron-builder and Node name platforms differently.** electron-builder's `${os}` expands to `win`, `mac`, or `linux`; the native loader uses Node's `win32`, `darwin`, or `linux`. `extraResources` therefore uses `${platform}-${arch}`, and every release runner builds the binary it will package.

---

## 5 · Architecture

### 5.1 Layout

What is on disk today:

```
packages/
  core/      TypeScript, no DOM, no framework   <- 80% of test effort
  agent/     Agent Host and harness adapters
  fs/        Rust behind N-API; the only platform binary
apps/
  desktop/   Electron: windowing, packaging, and — for now — the editor
e2e/
  ime/       IME gate; required before any Electron bump
```

Planned for v0.2, and named here so nobody builds around their absence:

```
packages/
  editor/    the manuscript surface, lifted out of apps/desktop
```

An earlier revision of this section drew `editor/` and `ui/` as though they
existed. `ui/` was an empty package whose `exports` pointed at a file that had
never been written, which tells a contributor to put UI code somewhere no build
would find it; it has been deleted. `editor/` is a real commitment, so it stays
— under a heading that says it has not been built.

### 5.2 Rules

1. **`core` has no DOM and near-zero runtime dependencies.** Text engine, Revision Store, Review Engine, and protocol codecs live here and run under `bun test` alone.
2. **The renderer consumes `core`.** It invents no data formats and touches no protocol files directly.
3. **`agent` is the only harness surface.** Protocol drift is absorbed there and never reaches `core`.
4. **The shell is replaceable.** `apps/desktop` holds no business logic. *Not yet true: it currently holds the editor and the IPC coordination for heads, proposals, and commits. `packages/editor` is the first half of paying that off.*
5. **The editor core is framework-free.** ProseMirror owns the DOM; Svelte owns the shell; an explicit command interface separates them. No framework code sits on the IME path. *Not yet true: the manuscript is a `contenteditable` in `App.svelte`, and Svelte reactivity sits on the input path. This is the rule v0.2 must satisfy, not a description of today.*
6. **Heavy work runs outside the renderer.** Text engine, diffing, indexing, and Agent Host live in a separate process; the renderer only presents and accepts input. *Not yet true: they run in the Electron main process, where a large diff or a synchronous scan blocks the window.*
7. **`fs` is the only native boundary.** It owns path admission, traversal, search, sort, file operations, and trash integration. Every mutating call passes through its guard; no caller can request permanent deletion.
8. **A release binary is built where it runs.** Windows x64, Linux x64, and both macOS architectures each build and test their own N-API binary before packaging. Matrix jobs upload artifacts; one final job owns the GitHub Release. *Releases currently ship Windows x64 only; the other three are configured but not published.*
9. **The main process grants Root authority.** Renderer state may request remembered paths but cannot authorize them. A picker, drop, create, OS-open event, or a permit already stored in main-owned application state grants one canonical Root identity; every mutation rechecks that identity, and Source Backup is never eligible.

Rules 4, 5, 6, and 8 carry an italic note because they were being read as
descriptions of the system when they are commitments about it. A baseline that
cannot be told apart from a status report is the mechanism by which a project
builds on guarantees it does not have.

### 5.3 Responsibilities

| Area | Owns | Does not own |
|---|---|---|
| Text engine | Text Action, Text Change, Text Head, range lineage, selective undo | Agent calls, harness sessions |
| Revision Store | Pinning, reading, verifying immutable heads | Proposals, authorization |
| Review Engine | Artifact validation, Proposal, Review Slice, three-way comparison, Decision Batch | Deciding which Proposal wins |
| Verdict Ledger | Persisting, searching, and serializing verdicts | Mutating the manuscript |
| Agent Host | Agents, sessions, runs, queue, Automation Grant | Manuscript editing, harness-native UI |
| Harness Adapter | One harness: launch, message, cancel, usage, capability verification | Faking uniform capability across harnesses |
| File layer | Path admission, indexing, search, sort, guarded operations, system trash | Manuscript semantics, agent dispatch, UI state |

---

## 6 · Harness adapters

### 6.1 Three tiers

Missing capability is not rejection. It is **degradation plus honest labeling**.

| Tier | Requires | Enables |
|---|---|---|
| **L0 file** | Nothing | The agent writes a Result Artifact to an agreed path; the app watches disk. Works with any harness, including copy-paste |
| **L1 session** | Programmatic launch, completion events, cancellation | Dispatch, cancel, status |
| **L2 trusted** | Honest usage reporting, effective-model readback, compaction events | Real token figures, trustworthy context warnings |

### 6.2 Interface

```ts
type Capability<T> =
  | { kind: "actual"; value: T }
  | { kind: "estimated"; value: T; method: string }
  | { kind: "unknown" };

interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

interface SessionUsage {
  byModel?: Record<string, TokenUsage>;
  currentTurn?: TokenUsage;
  total?: TokenUsage;
}

interface HarnessAdapter {
  readonly id: string;
  readonly tier: "L0" | "L1" | "L2";

  createSession(binding: RuntimeBinding): Promise<Session>;
  dispatch(session: Session, envelope: TaskEnvelope): Promise<RunHandle>;
  cancel(run: RunHandle): Promise<void>;

  usage(session: Session): Capability<SessionUsage>;
  effectiveModel(session: Session): Capability<string>;
  onCompaction?(cb: (e: CompactionEvent) => void): void;
}
```

`Capability<T>` is the honesty switch of this design: **unknown is a first-class value, not a zero quietly written in**.

`SessionUsage` takes its three-layer shape from Kimi Code, which resolves the cumulative-versus-incremental ambiguity. Weaker harnesses leave fields `undefined`.

### 6.3 Launch adapters

| Harness | Tier | Entry point | Evidence |
|---|---|---|---|
| **Codex** | L2 | `codex app-server --stdio` | `thread/tokenUsage/updated` carries both `total` and `last`; `model/rerouted` is execution evidence; `contextCompaction` rides the standard item stream |
| **Claude Code** | L1; model and usage parsing implemented | `claude -p --output-format json` | `usage` reports input, output, cache-read, and cache-creation tokens; a real session and compaction signal must pass §6.5 before L2 |
| **Pi** | L2 | RPC (custom JSONL over stdio) or SDK | `AssistantMessage.usage` is required, not optional; `compaction_start/end` carries a three-state `reason` |
| **Kimi Code** | L2 | node-sdk `KimiHarness` | `SessionUsage` provides `byModel` / `currentTurn` / `total`; four compaction events with `tokensBefore/After` |
| **Hermes** | L1+ | TUI Gateway JSON-RPC | Usage is session-cumulative and needs differencing; API Server emits no compaction event; [issue #33072](https://github.com/NousResearch/hermes-agent/issues/33072) remains open |

### 6.4 Adapter hazards

| Harness | Hazard |
|---|---|
| Codex | The default usage channel is populated by estimation and replay. Accumulate `last` for accounting and dedupe the first notification after resume or fork. `turn/completed` carries only a summary — accumulate `item/*` for full output. `ReasoningEffort` is an open string; read it from `model/list` rather than hardcoding |
| Claude Code | The current print-mode report is one result, not a per-subagent ledger. Relay only the four fields under `usage`; never expose `total_cost_usd`. A stub process proves parsing and lifecycle, but §6.5 still requires a real installed CLI session before the README may call the tier verified |
| Pi | **Do not parse RPC frames with Node `readline`** — it splits on `U+2028/U+2029`, which are legal inside JSON strings. Use `agent_settled`, not `agent_end`, as the completion signal. `usage.reasoning` is part of `output` and must not be added to it. `packages/server` is experimental; do not build on it |
| Kimi Code | Print mode emits no usage; use node-sdk or the KAP WebSocket. AgentSwarm supports up to 128 subagents and offers `resume_agent_ids` |
| Hermes | `/v1/runs` silently drops `model` unless `provider` accompanies it. `_set_run_status` stores the requested value, not the effective one. SSE buffers expire after five minutes — consume continuously |

### 6.5 Contract tests

Every adapter proves, against a real session and run:

1. Model and reasoning effort can be set and read back — or are explicitly declared unlockable.
2. Consecutive runs on one agent always use the same Runtime Binding.
3. Request echo is never treated as execution evidence.
4. Binding one agent does not pollute other sessions or global defaults.
5. Usage and capacity are tagged `actual`, `estimated`, or `unknown`; estimates state their method.
6. Cancellation reaches a terminal state.
7. Compaction events mark the session lineage-unverifiable.

Report the tier reached; the README publishes the table. **An L0 adapter takes a few dozen lines.**

---

## 7 · The Verdict Ledger protocol

### 7.1 Result Artifact

Written atomically on completion. Three sections; the app generates the first two, the agent fills only the third.

````markdown
# Before

[the text of each Edit Scope at the baseline Revision]

# Request

[the user's prompt]

# Agent reply

<agent-result version="1">
  <replacement scope="s1" format="markdown"><![CDATA[replacement text]]></replacement>
  <comments>
    <comment target="s2"><![CDATA[a comment]]></comment>
  </comments>
</agent-result>
````

Rules:

- `<agent-result>` is the only root element. No free text outside it; prose goes in `<comment>`.
- At most one `<replacement>` per scope. Absent means comment-only; `<replacement scope="s1" />` means delete that slot.
- `target` must be a stable boundary ID the system supplied. An invented target invalidates that comment.
- The parser disables DTDs, external entities, and network access, and rejects unknown elements, duplicate replacements, invalid UTF-8, and excessive nesting.
- Write to a temp file, validate structure and provenance and the hash of the first two sections, fsync, then rename atomically. A failed candidate is kept as a diagnostic file under an attempt ID and never becomes a Result Artifact.

### 7.2 Verdict

```ts
type VerdictKind = "accept" | "accept-modified" | "reject" | "comment-only";

interface Verdict {
  id: string;
  proposalId: string;
  sliceId?: string;          // absent = the whole Proposal
  kind: VerdictKind;
  finalText?: string;        // required when accept-modified
  reason?: string;           // presence and absence are distinguishable
  baseline: RevisionId;
  decidedAt: string;
}
```

**`reason` is the ledger's most valuable field.** A verdict with stated reasoning is the signal worth replaying to an agent, so present and absent must remain distinguishable — never paper over the difference with an empty string.

### 7.3 Reply format

Verdicts serialize into a single ordered stream:

```xml
<changes>
<verdict n="1" ref="s1" kind="accept-modified">
  <final><![CDATA[the user's final text]]></final>
  <reason>Sharpened the pivot; the original conceded too early.</reason>
</verdict>
<verdict n="2" ref="s2" kind="reject">
  <reason>Drifts from the voice this character has already established.</reason>
</verdict>
</changes>
```

Ordered by `n`, stable across exports, so the prefix stays byte-identical and agent-side caching hits.

### 7.4 Decision Batch semantics

On submit, with the current Text Head as `commit_basis`:

1. Each Verdict references a Proposal ID, a Review Slice ID, a kind, and final text. Rejections and comment-only verdicts enter the audit record without producing a Text Change.
2. For partial acceptance, the Review Engine deterministically applies accepted slices to the Proposal's before-text, rebuilding one final replacement for that Edit Scope.
3. Each final replacement maps from its own baseline Revision onto `commit_basis`, with before-text verification and three-way comparison.
4. Mapped Text Changes must be pairwise disjoint. On conflict the batch does not commit — **the system never picks a winner by hidden ordering**.
5. The commit transaction re-checks the current Text Head against `commit_basis`. A mismatch aborts the whole batch; partial writes are impossible.
6. One Decision Batch yields one Text Action, one new Text Head, immediately pinned as a Revision.

Disjoint Proposals must satisfy `merge(A, then B) == merge(B, then A)`.

---

## 8 · Code style

### 8.1 Machine-enforced rules stay out of prose

Biome, one config: two-space indent, 100-column width, double quotes, semicolons, trailing commas, sorted imports. Not worth discussing; `bun run fmt` fixes it.

Prettier plus ESLint is rejected: two configs fight, and the combination is slow enough that nobody enables format-on-save. **A convention is followed only when it is painless.**

### 8.2 Types

1. **Make illegal states unrepresentable** rather than describing legal ones. Use discriminated unions for state machines.
2. **Validate at boundaries; trust types inside.** External input — Result Artifacts, adapter returns, config files — passes a schema once and is not re-defended afterward.
3. `any` is forbidden. `unknown` is the correct boundary type. An assertion carries an inline note on why the type system falls short.
4. **Do not simulate an interpreter in the type system.** Recursive conditional types and template-literal gymnastics need to buy real caller safety or they are rejected.

### 8.3 Structure

5. **One line, one complete idea.** Delete explanatory temporaries, ceremonial control flow, shallow wrappers.
6. **An abstraction must earn its place** by enforcing an invariant, isolating a likely change, or naming a composed concept. None of the three: three similar lines beat a premature abstraction.
7. Functions over classes. No DI framework, no decorators.
8. **Module boundaries are contracts.** Each package exposes one `index.ts`; importing a private path across packages is a lint error.

### 8.4 Naming

9. **Domain vocabulary is single-authority** (§2), across code, comments, UI strings, docs, and test names. No synonyms. This single rule does the most to keep the project from rotting.
10. Identifiers in English; comments explain *why*, never *what*. A "what" comment is evidence the code is unclear.
11. **Write invariants down.** Rules like "Source Backup is never written to" get one comment on the guarding function and one test.

### 8.5 Size limits

| Item | Limit | On exceeding |
|---|---|---|
| TS module | 400 lines | Keep it if you can state why; otherwise split |
| Function | One screen | Same |
| `core` runtime dependencies | Near zero | Register additions with a reason |

Limits exist to force an explanation, not to forbid.

### 8.6 What machines cannot check

12. **Read the callers before changing a function.** Skipping this causes the most rework in this project.
13. **One commit does one thing.**
14. **Green assertions are not correctness.** UI changes require looking at rendered pixels; protocol changes require a real round trip.

---

## 9 · Testing

Concentrate on `core`: property-based protocol round trips, anchor corpora, three-way mapping, Decision Batch composition. Adapters use contract tests (§6.5) against real sessions. UI covers only decisive paths: Proposal appears, verdict recorded, ledger correct.

**Corpora are assets.** Anchor drift, long documents, and real Result Artifacts from each harness live in `fixtures/`. A new bug enters the corpus before it is fixed.

### 9.1 White-box invariants

**INV-5 · Source fidelity.** Bytes the author did not edit come back unchanged. Loading strips nothing; saving replaces only the ranges whose text actually changed and slices everything else out of the original. This is a lower bound, not lossless Markdown — a paragraph the author rewrites is rewritten — and it holds for the ideographic indent that opens a Chinese paragraph, blank lines inside a fence, consecutive blank lines, hard line breaks, CRLF, a missing final newline, and a byte-order mark. One authority decides where a block begins, because block identity is positional and two processes disagreeing about it renumber every block after the disagreement, silently detaching queued Proposals from the text they were written against. Gate: `verify:roundtrip`, over twenty corpora, asserting SHA-256 and block counts.

**INV-8 · Bounded alignment.** No alignment allocates a table proportional to the whole manuscript. The cost of a save follows the size of the change, not the length of the book. A region past the table budget is reported as a wholesale replacement rather than aligned — refusing to allocate is the behaviour; attempting it is what took the application down. Gate: `verify:scale`, six mutation shapes up to 100,000 blocks.

**INV-9 · Composition is not text.** Text under construction by an input method is a candidate. Nothing reads it back as the manuscript, nothing writes it to disk, and no redraw replaces the node the input method is composing into. A save requested mid-composition is deferred to `compositionend`, not refused: the author pressed Ctrl+S and meant it. Gate: `apps/desktop/scripts/verify-composition.ts`.

Only a Text Action mutates the manuscript. Source Backup is never written. Exactly one current Text Head. Run dispatch and Revision binding are atomic. A dispatched run's baseline never changes. Result Artifacts are complete, atomic, verifiable. No replacement produces no Proposal. Proposals are immutable. Disjoint Proposals commute. Decision Batches are atomic. No automatic merge path exists. Runtime Binding is never overridden per run. Deleting a Result Artifact changes neither the manuscript nor a frozen Proposal.

### 9.2 Black-box paths

Install, launch, crash recovery. Continuous CJK input and IME composition. Full editing, search, save, and undo while the Agent Host is offline. Batched dispatch and the consolidated manifest. Single agent, competing agents, cancellation, timeout, late results. Merge as-is, merge revised, reject, comment-only. External deletion of a Task Workspace surfaces as missing. Forced restart restores manuscript, queue, results, and review state.

---

## 10 · Performance

Thresholds are set from measurements on real long-form Chinese text, not invented in advance. Measurement must cover: input latency and IME stability; large pastes and multi-site Decision Batches; indexes at 10^5 Text Changes; selective undo of the first action after 10,000 disjoint ones; startup and restore time; resident memory and disk growth; a 100-run result list with on-demand loading; manuscript responsiveness while parsing is queued.

The real bottleneck is architecture, not arithmetic: chapter granularity, on-demand disk reads, and keeping heavy work off the main thread.

Measured, one word changed in a manuscript of n blocks, before and after `align.ts` (v0.1.5):

| Blocks | Before | After |
|---:|---:|---:|
| 20,000 | 5,219 ms | 5.5 ms |
| 40,000 | `RangeError: Out of memory` | 7.4 ms |
| 100,000 | `RangeError: Out of memory` | 25.3 ms |

The crash was not a function of the edit. The table is allocated before anything is compared, so correcting one character cost what rewriting the book cost.

---

## 11 · Milestones

### M0 · Toolchain and gates

Make the conventions executable before the first line of product code.

Deliver: monorepo skeleton, `biome.json`, `tsconfig.json` (TS 7 strict), CI with three gates, the IME gate project.

TypeScript 7 is new enough that build-tool compatibility must be proven, not assumed: run the full TS 7 + Bun + Svelte chain on real `core` code.

Accept: `bun run fmt:check`, `bun run check`, `bun test` all green; the IME gate runs on Windows and produces a report.

Status: gates green (§4.3 records what the chain actually required). The IME gate has landed: `e2e/ime/` holds the project and `.github/workflows/ime-gate.yml` runs it. It does not yet run on a hosted runner, and `release.yml` does not depend on it — so "an Electron bump must pass the IME gate" is a rule with a door and no latch.

### M1 · `core`

Domain types (§2), text engine, Revision Store, Result Artifact codec, Verdict Ledger — all without DOM.

Accept: property-based protocol round trips are identities; Decision Batch composition is correct including conflict refusal; selective undo is correct after 10,000 disjoint actions; every §9.1 invariant is covered.

### M2 · Editor and review

ProseMirror opens chapterized documents; Proposals render as decorations; slices are adjudicated; verdicts persist.

Accept: three injected Proposals (replace, delete, insert) render at correct positions; accepting applies to the manuscript and appends a Verdict; merge-revised records `finalText` and `reason`.

### M3 · Agent Host and the first adapter

Agent Host, the L0 file channel, and one L2 adapter (Codex or Pi — their evidence is the most complete).

Accept: contract tests (§6.5) pass; batched dispatch completes end to end; cancellation reaches a terminal state; the three usage states display correctly.

### M4 · Remaining adapters and packaging

Claude Code, Kimi Code, Hermes, L0 documentation, and a Windows installer.

Accept: the tier table is re-verified in a real environment; a clean machine passes smoke tests.

---

## 13 · The file layer

`packages/fs` is a Rust crate exposed through N-API. It exists because four operations sit on the interaction path and JavaScript cannot make them fast enough: a parallel directory walk, SIMD substring search, a linear sort over contiguous memory, and a recoverable delete that has no JavaScript binding on any platform.

**Measured on this machine** — a 20,000-file tree, warm cache, p50 over ten runs:

| Operation | p50 | p95 |
|---|---:|---:|
| Scan 20,000 files | 10.38 ms | 11.33 ms |
| Sort by name, natural order | 0.80 ms | 0.94 ms |
| Substring search | 6.66 ms | 8.22 ms |
| Subsequence search | 7.71 ms | 10.24 ms |
| CJK search | 5.88 ms | 6.99 ms |
| Page 200 rows | 0.13 ms | 0.17 ms |

Each fits inside a 120 Hz frame budget of 8.3 ms, except the scan, which runs once per open.

### 13.1 Rules

1. **The index stays in Rust.** The renderer receives the page it can display. Shipping 20,000 entries across the bridge per keystroke is the cost this layer exists to remove.
2. **Every mutating call passes through `Guard::admit`.** It resolves the canonical path, so `../` and a symlink out of the tree are refused by one test rather than two. It refuses the Source Backup, paths outside every root, and names Windows would mangle — on every platform, so a manuscript survives being copied between machines.
3. **Delete goes to the system trash.** `IFileOperation` on Windows, `NSFileManager` on macOS, freedesktop.org on Linux. There is no permanent variant at any layer, and `bun run verify:trash-only` fails the build if one appears.
4. **A failed trash leaves the file.** Measured on Linux: a workspace on a volume without a writable trash directory cannot delete recoverably. The operation fails, the file stays, and the interface names it.
5. **The editor does not depend on the file layer.** A machine without a platform binary keeps opening, editing, saving, and reviewing; it loses the browser and is told which platform lacks a build.
6. **Names are folded once, during the walk.** Folding per keystroke allocates once per entry per character typed.
7. **Search offsets are character offsets.** A byte offset lands mid-character in any CJK name and underlines the wrong glyph.
8. **Numbers sort as numbers.** `chapter-10` follows `chapter-9`. Lexicographic order is wrong for every numbered manuscript, which is most of them.

## 14 · Display matching

Two facts about the panel change how the application draws, and neither is knowable at build time.

**Refresh rate.** A 165 Hz panel has a 6.06 ms frame budget, a 60 Hz panel 16.67 ms. Durations are expressed in frames of the measured rate: eight frames is 133 ms at 60 Hz and 48 ms at 165 Hz, and both read as the same gesture. Electron reports 0 Hz on some Linux compositors and in virtual displays; 60 is the safe reading, because scheduling work a panel cannot show drops frames the user does see.

**Pixel density.** A hairline is `1 / scaleFactor` CSS pixels — one device pixel. At 300% scaling a 1px border is a blurry three-pixel smear, and the manuscript's ruled baseline grid is made of hairlines.

The profile is per window, not per application: dragging from a laptop panel to a desktop monitor retargets the budget. The main process measures; the renderer applies. A second opinion about the frame budget would be a second source of truth.

## 12 · Open questions

| # | Question | Status |
|---|---|---|
| Q1 | Product and repository name | Closed — `RefRain`, chosen 2026-07-26. A reference and a refrain. (An earlier draft named 雨 as the default theme; no such theme exists — the default is 濤, see Q9.) |
| Q2 | May a human and an agent edit the same file concurrently? (Leaning: the file is read-only to the human while an agent works on it) | Open |
| Q3 | UI for cross-session multi-agent dialogue orchestration | Needs design |
| Q4 | Does the Verdict Ledger's retrieval interface ship in v1? | Closed — yes, as `search` over stated reasoning. An earlier answer also promised a compiled taste profile; that was withdrawn. Reducing scattered verdicts to "what this writer wants" is inference, and an application that makes no network calls and holds no model cannot perform it. The ledger informs a persona the author writes; it does not write one. |
| Q7 | An agent's identity is authored, not inferred — a `Persona` the writer edits, with per-agent control over whether it travels every round, only the first, or never. One harness and one model therefore yield several collaborators, distinguished by brief rather than by runtime binding. | Closed — 2026-07-26 |
| Q6 | Does a proposal-level `accept` with no slice verdicts mean "take all of it" or "take none of it"? | Closed — 2026-07-26. **Neither: there is no proposal-level accept.** The button the author wanted was never "merge without judging"; it was "I have read all twenty and I agree, stop making me click". Those differ in the ledger, and the ledger is the point. So the proposal header offers **select all** — one click stages an `accept` verdict for every slice, the whole proposal lights up, and the author still presses Merge. Twenty verdicts reach the ledger, each separately revisable; a single "accepted the lot" row would lose the grain the Verdict Ledger exists to keep. `rebuildReplacement` keeps its meaning: an unjudged slice is refused. **Select all refuses** is the symmetric action. |
| Q8 | A workspace on a volume whose root is not writable cannot have a trash directory created, so the delete fails and the file stays. | Closed — 2026-07-26. The refusal stands; what changes is that it stops being a dead end. When the trash on the workspace's own volume is unavailable, the interface says so — *this location has no trash, so nothing here can be deleted safely* — and offers one action: **move it to the system trash**, meaning the trash on the volume that holds the user's home. That is a cross-device move followed by a trash, and `ops.rs` already performs both (the `EXDEV` branch copies, verifies, then trashes the source). If the home volume has no trash either, the interface explains and offers nothing. **No permanent delete appears at any layer, on any path.** The file always ends up somewhere the operating system can restore it from. |
| Q5 | Does the chapter header share the manuscript's left edge? | Closed — 2026-07-27. **There is no drift. There never was; the fixture never opened.** Reported first as a 289px layout defect, then reopened as a measurement fault when the selector turned out to be matching `Progress.svelte`'s `.bar`. Both readings were of a blank screen. Three things in the stub had gone stale and each alone emptied the fixture: the panel search typed 打开文件夹, the welcome screen's wording, while the command is 打开项目… (`cmd.open`); `loadWorkspace` returned a bare chapter array rather than a `WorkspaceView`; the chapter carried no `rootId` and no `role`, and the rail groups by `rootId`. With the fixture open, header and sheet both sit at 497px — **drift 0px**. The gate's click is no longer conditional, and its `continue-on-error` in CI is removed. |
| Q9 | Are the eight themes settled, and how do day and night relate? | Closed — 2026-07-27. **Day: 濤 tou, 霞 kasumi, 枯 kare, 林 hayashi, 瓷 seiji. Night: 墨 sumi, 幽 yu, 時雨 shigure. Default 濤.** Night is not day inverted: each palette is drawn from its own reference, so N themes means N, not N×2, and the light/dark command crosses between the two groups remembering where the writer was on each side. `docs/theme-tokens.ts` is the single authority; `themes.css` is generated and must not be hand-edited. |
| Q10 | Which Japanese faces ship, alongside which Chinese ones? | Closed — 2026-07-27. Three slots rather than two: Chinese, Japanese, and Latin are separate settings, because one CJK slot cannot serve both a Chinese and a Japanese reader — 直, 骨, and 令 are drawn differently and a single face gets one of them wrong. **Japanese sans: Zen Kaku Gothic New** (OFL 1.1, no reserved name, five weights, freely subsettable). **Japanese serif: KazukiReiwa 一樹令和** (OFL 1.1; "KazukiReiwa" *is* a reserved name, and the 20–27 MB weights make subsetting unavoidable, so the shipped subset is renamed `RefRain Mincho`). **Chinese sans: ChillDINGothic** (OFL 1.1, reserved names `ChillDIN`/`ChillDINGothic`/`Source`; rename on subset). Chinese serif stays Chiron Sung HK. Rejected: 致一黑體_傳承形 and Mizuki-Gothic are IPA Font License — legal to ship only byte-for-byte, unrenamed, unsubsetted, and as a standalone file rather than linked into the executable; MiSans and OPPO Sans forbid redistributing the font binary at all. Evidence: two rounds of licence due diligence reading each upstream LICENSE directly and inspecting the binaries with fontTools. |
|| Q11 | Does a project collect Markdown from subdirectories, and as what? | Closed — 2026-07-27. **Material first, then chapters.** A subdirectory's Markdown is material by default — notes, chronologies, sources — and a chapter is the role a file is promoted into, not the role every `.md` starts with. Getting this backwards puts a chronology into the chapter sequence, where it corrupts numbering, the progress rule, and the send manifest. Presentation is a tree, expanded by directory; a graph view of the links between files may be added later as a second view, never as the only one. |
642|
| Q11 | Does a project collect Markdown from subdirectories, and as what? | Closed — 2026-07-27. **Material first, then chapters.** A subdirectory's Markdown is material by default — notes, chronologies, sources — and a chapter is the role a file is promoted into, not the role every `.md` starts with. Getting this backwards puts a chronology into the chapter sequence, where it corrupts numbering, the progress rule, and the send manifest. Presentation is a tree, expanded by directory; a graph view of the links between files may be added later as a second view, never as the only one. |
| Q12 | Where does a 念頭寄存 note live, and what happens when the ledger is unavailable? | Closed — 2026-07-27. **`kara_note` is a Verdict Ledger row.** A stray thought caught mid-sentence is a judgment about the work, which is what the ledger holds; giving it a second store would split the authority the ledger exists to keep. The ledger is optional (C-1), so when it is unavailable the command is unavailable and says why, rather than accepting a note into a place that will not keep it. Losing a note silently is worse than refusing to take one. |
| Q13 | Does Review staging survive the panel closing, and what are its parts? | Closed — 2026-07-27. **Persisted, and split three ways: `verdicts` / `batch` / `cursor`.** They have different lifetimes — a verdict outlives the panel, a batch is what the author is about to commit, a cursor is where they were reading. Holding them in one object is what let a closed panel and a failed commit each destroy all three. |
| Q14 | Is a partial merge a legal Text Action? | Closed — 2026-07-27. **Yes, and unmerged Verdicts survive it.** An author who accepts eleven of twenty slices has made eleven judgments, and the batch commits those eleven. The other nine stay staged rather than being discarded as the price of committing. This follows §7.4: a Decision Batch is atomic over what it commits, not over what was staged. |
| Q15 | What is a ReviewUnit, and does it change the ledger? | Closed — 2026-07-27. **Presentation only.** An adjacent `del` + `ins` pair reads as one substitution and is judged as one, but still writes two Verdicts. The ledger records what changed in the text; the interface records what the author looked at. Collapsing the ledger to match the display would lose the grain that makes a verdict replayable. |
| Q16 | How do Stage, Reference and Safety differ? | Closed — 2026-07-27. **By lifetime, not by appearance.** Stage is the work in hand and persists across sessions. Reference is consulted and closed, holding nothing. Safety interrupts and is the only one permitted to be modal — a conflict the author must resolve before the manuscript can move. Review and Dispatch stay drawers, separate from settings: settings is a Reference and must not evict work in progress by sharing its slot. |
| Q17 | Does 空 measure or report time? | Closed — 2026-07-27. **No clock, no leave prompt, no session statistics.** Nothing ends immersion except the author leaving it or a safety failure. A break reminder recreates the cost of re-entry it claims to be sparing, and for the reader this product is built for, re-entry is the expensive part. |
| Q18 | How does 空 shade the surrounding text? | Closed — 2026-07-27. **Five steps: 100% for the current paragraph and its immediate neighbours, then 92% / 84% / 76% / 68%.** Three paragraphs at full ink rather than one, because a sentence being written usually continues one already on screen. A sharper falloff turns the context grey exactly when it is still needed. |
| Q19 | Which keys enter and leave 空? | Closed — 2026-07-27. **`Ctrl+Enter` both ways; Escape never leaves.** Escape closes everywhere else in this product, and this is the single exception — deliberately. Immersion that a reflexive keypress can end is not immersion, and the reflex is common enough that the exception is worth the inconsistency. |
| Q20 | Does the rail narrow itself? | Closed — 2026-07-27. **Off by default.** Layout that moves without being asked costs a re-orientation each time, and the author did not ask for it. It remains available to those who want it. |
| Q21 | What does Ctrl+K show that cannot be run? | Closed — 2026-07-27. **Outside 空: unavailable commands appear, each stating the next step** — *merge — judge at least one slice first* — because a command that vanishes teaches nothing, while one that explains itself teaches the workflow. **Inside 空: only the six commands 空 answers to.** Showing the rest would be an invitation out. |
| Q22 | Where do application state and the immutable Source Backup live when the Root is one Markdown file rather than a directory? | Closed — 2026-07-27. **In one adjacent companion named `.<filename>.refrain/`.** Its `.refrain/` child holds mutable application state; its `.refrain-source/` child holds the immutable original. The exact filename binds the companion to one explicit Root, so no neighbour is adopted; moving the source and companion together preserves the Project. RefRain writes a layout marker before use and refuses a pre-existing unowned directory or symlink instead of claiming it. |
| Q23 | Should failure to take a Source Backup block folder-Root adoption? | Closed — 2026-07-27. **No. Preserve access and make the loss explicit.** The Root remains editable, while the existing Notice names the concrete copy failure and reappears on each open until the backup succeeds. A safety copy that cannot be made must not become a silent lockout of a manuscript the author can otherwise read and write. |
| Q24 | May a project persist permission to execute the command in its own `agents.json`? | Closed — 2026-07-27. **No. Command trust lasts for the current application session only.** The project file is the untrusted input, so accepting `trusted: true` from that same file would let a downloaded project authorize itself. On every reopen, RefRain shows the exact argv as a JSON array and waits for the author before registering or probing the command adapter. A future remembered-trust feature must live in user-controlled application state and bind the canonical Root plus an argv digest; it may not be written by the project. |
| Q25 | When is a persisted Root permission checked, and what happens when the folder drifted? | Closed — 2026-07-27. **Permission and filesystem identity are two different questions, answered at two different moments.** A Root permit lives in user-controlled application state (`userData/roots.json`) and pins the canonical path, device, and inode. Loading a workspace asks only whether a path holds a permit — an in-memory lookup that never touches the disk, so an author who cleaned a drive and reopened RefRain is not met with one warning per vanished Root. Identity is verified on the first call that actually uses that Root; a drifted or retargeted path has that one operation refused with a concrete reason. RefRain reports and does not repair: there is no second copy, and pretending to restore one would be worse than saying so. |