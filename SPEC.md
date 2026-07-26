# SPEC — Design Baseline

> v0.1.0 · 2026-07-26 · This file is the authoritative design baseline.
> When an implementation disagrees with this document, change the implementation.
> Append a Changelog line for every edit. Never rewrite history silently.

## Changelog

- 2026-07-26 v0.1.3 — The file layer (§13) and display matching (§14). A native Rust crate, `packages/fs`, holds traversal, search, sort, and a delete that goes to the system trash; it is the only package carrying a platform binary. Motion and hairlines derive from the panel's measured refresh rate and scale factor rather than from constants. Q8 opened for the cross-volume trash failure measured on Linux.
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
| ProseMirror | 1.42.x | Editor core, no framework |
| Biome | 2.5.5 | Formatter and linter, one config |

### 4.1 Why Electron, not Tauri

The criterion is not which framework is better. It is **who controls the engine version**.

A Chinese IME regression exists between Chromium 149.0.7827.54 and .103: `contenteditable` swallows the first composition character, and Chinese punctuation requires two keypresses.

- [tauri#15436](https://github.com/tauri-apps/tauri/issues/15436) — on Windows, first focus on a ProseMirror `contenteditable` containing existing text deadlocks TSF. Workarounds in both Rust and JS failed.
- [WebView2Feedback#5625](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5625) — unfixed on WebView2 149 Evergreen; JS-layer mitigation ineffective.
- [web-text#1](https://github.com/ale-160/web-text/issues/1) — bisected to that exact range using two Edge builds.

WebView2 Evergreen updates on Microsoft's schedule; an app cannot pin or revert it. Electron ships Chromium inside the bundle, so **the project decides when to take a new engine**.

A measured test (four shells × four criteria, Microsoft Pinyin driven by `SendInput`) found no reproduction on current engines. Its author stated the confidence boundary: machine cadence is not human cadence, and fixed-interval keystrokes cannot surface TSF races that appear only under irregular typing. Hence the conclusion is **relax the pin, keep the gate** — not remove the gate.

### 4.2 Why no Rust in this codebase

Bun's core is already Rust (64.6% of the repository, with 21.4% C++). File I/O, SQLite, hashing, and process management run on Rust while we write TypeScript. **Rust is in the foundation; it need not enter the house.**

Our own code carries domain logic — transaction semantics, three-way mapping, protocol contracts. Its bottleneck is correctness and changeability, not throughput. Its readers are contributors writing harness adapters, and that ecosystem is almost entirely TypeScript.

The door stays open under one condition: if an M0 performance gate fails on a specific operation, lower **that one function** into a native module. Do not rewrite a layer.

### 4.3 Colour, and why the default is cool

Warm paper is the settled answer for writing tools, which is why they look
alike. The default palette here is 雨 — a cool ground near hue 235 with chroma
around 0.012 — and the reason is not novelty.

**Cinnabar needs a cool ground to read as heat.** On cream the same red merely
sits there; against a cool sheet it is the only warm thing on screen, which is
what an accent reserved for human decisions should be.

**Cool paper wants warm ink.** Matching the ink to the paper's hue produces a
tinted PDF: technically harmonious, materially dead. The charcoal leans warm
(hue 48) and is stated as solid values, never as a tint of the ground — dilute
a warm charcoal with opacity and it becomes grey, which is how an earlier
"warm ink" arrived on screen as no ink at all.

**Chroma is the difference between a sheet and a callout.** At 0.034 a
viewport of it reads as an information panel. Cool comes from hue.

The warm palette remains as 楮, and the dark one as 夜. All three are stated in
OKLCH: lightness can be lowered while chroma and hue hold, which is what lets
the dark theme read as a lamp on paper rather than as an inverted screen.

### 4.4 Toolchain findings, measured

M0 required proving the TypeScript 7 chain rather than assuming it. Three findings changed the build:

1. **The binary is `tsc`, not `tsgo`.** `tsgo` was the name under `@typescript/native-preview`; 7.0.2 ships the native compiler as `tsc`. `node_modules/typescript/lib/tsc.js` is a thin Node shim that `execve`s the native executable.
2. **Piping a gate destroys its exit code.** `tsc --noEmit | head` exits 0 with type errors present. CI runs every gate unpiped, and `scripts/verify-gate.ts` feeds the typechecker code that must be rejected — a gate that cannot fail is worse than no gate.
3. **`allowImportingTsExtensions` is mandatory.** Bun executes `.ts` directly, so imports carry the extension; without this flag TS 7 rejects every internal import.
4. **`svelte-check` 4.7.3 crashes under TS 7**, reaching for `useCaseSensitiveFileNames` on an internal API that no longer exists. `apps/desktop/scripts/check-svelte.ts` compiles every component with Svelte's own compiler instead, which is the authority on its syntax anyway.
5. **Biome lints only a Svelte file's `<script>` block**, so template references read as unused variables. Biome formats `.svelte`; the compiler check owns its linting.
6. **Electron loads CommonJS**, so `main` and `preload` are bundled to `.cjs` — under `"type": "module"` a `.js` CJS bundle fails at launch, which no unit test reaches. `apps/desktop/test/smoke.test.ts` asserts the build shape, and CI launches the real binary with `--smoke` and requires the window to report a finished load.
7. **`core` runs in two runtimes with disjoint SQLite builtins.** Bun 1.3 ships `bun:sqlite` and lacks `node:sqlite`; Electron's Node ships the reverse. A direct import of either passes every test in one runtime and throws at launch in the other — which is how `bun:sqlite` reached a release build and failed the launch gate. `packages/core/src/sqlite.ts` selects at runtime, `packages/core/test/runtime.test.ts` forbids a top-level `bun:` import anywhere in `core`, and `make.sh` exercises the Node branch with a real round trip.

---

## 5 · Architecture

### 5.1 Layout

```
packages/
  core/      TypeScript, no DOM, no framework   <- 80% of test effort
  agent/     Agent Host and harness adapters
  editor/    ProseMirror, no framework
  ui/        Svelte 5
apps/
  desktop/   Electron: windowing and packaging only
e2e/
  ime/       IME gate; required before any Electron bump
```

### 5.2 Rules

1. **`core` has no DOM and near-zero runtime dependencies.** Text engine, Revision Store, Review Engine, and protocol codecs live here and run under `bun test` alone.
2. **`ui` consumes `core`.** It invents no data formats and touches no protocol files directly.
3. **`agent` is the only harness surface.** Protocol drift is absorbed there and never reaches `core`.
4. **The shell is replaceable.** `apps/desktop` holds no business logic.
5. **The editor core is framework-free.** ProseMirror owns the DOM; Svelte owns the shell; an explicit command interface separates them. No framework code sits on the IME path.
6. **Heavy work runs outside the renderer.** Text engine, diffing, indexing, and Agent Host live in a Bun process; the renderer only presents and accepts input.

### 5.3 Responsibilities

| Area | Owns | Does not own |
|---|---|---|
| Text engine | Text Action, Text Change, Text Head, range lineage, selective undo | Agent calls, harness sessions |
| Revision Store | Pinning, reading, verifying immutable heads | Proposals, authorization |
| Review Engine | Artifact validation, Proposal, Review Slice, three-way comparison, Decision Batch | Deciding which Proposal wins |
| Verdict Ledger | Persisting, searching, and serializing verdicts | Mutating the manuscript |
| Agent Host | Agents, sessions, runs, queue, Automation Grant | Manuscript editing, harness-native UI |
| Harness Adapter | One harness: launch, message, cancel, usage, capability verification | Faking uniform capability across harnesses |

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
| **Claude Code** | L2 | Agent SDK `query()`, streaming input required | `modelUsage[model]` with six fields; `system/compact_boundary` carries `trigger` and `pre_tokens` |
| **Pi** | L2 | RPC (custom JSONL over stdio) or SDK | `AssistantMessage.usage` is required, not optional; `compaction_start/end` carries a three-state `reason` |
| **Kimi Code** | L2 | node-sdk `KimiHarness` | `SessionUsage` provides `byModel` / `currentTurn` / `total`; four compaction events with `tokensBefore/After` |
| **Hermes** | L1+ | TUI Gateway JSON-RPC | Usage is session-cumulative and needs differencing; API Server emits no compaction event; [issue #33072](https://github.com/NousResearch/hermes-agent/issues/33072) remains open |

### 6.4 Adapter hazards

| Harness | Hazard |
|---|---|
| Codex | The default usage channel is populated by estimation and replay. Accumulate `last` for accounting and dedupe the first notification after resume or fork. `turn/completed` carries only a summary — accumulate `item/*` for full output. `ReasoningEffort` is an open string; read it from `model/list` rather than hardcoding |
| Claude Code | Account with `modelUsage`, not `usage` — the latter excludes subagents. Dollar figures are local estimates and are officially documented as unsafe for billing. `setModel()` and `interrupt()` require streaming input mode. Deduplicate per-step usage by message ID |
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

Only a Text Action mutates the manuscript. Source Backup is never written. Exactly one current Text Head. Run dispatch and Revision binding are atomic. A dispatched run's baseline never changes. Result Artifacts are complete, atomic, verifiable. No replacement produces no Proposal. Proposals are immutable. Disjoint Proposals commute. Decision Batches are atomic. No automatic merge path exists. Runtime Binding is never overridden per run. Deleting a Result Artifact changes neither the manuscript nor a frozen Proposal.

### 9.2 Black-box paths

Install, launch, crash recovery. Continuous CJK input and IME composition. Full editing, search, save, and undo while the Agent Host is offline. Batched dispatch and the consolidated manifest. Single agent, competing agents, cancellation, timeout, late results. Merge as-is, merge revised, reject, comment-only. External deletion of a Task Workspace surfaces as missing. Forced restart restores manuscript, queue, results, and review state.

---

## 10 · Performance

Thresholds are set from measurements on real long-form Chinese text, not invented in advance. Measurement must cover: input latency and IME stability; large pastes and multi-site Decision Batches; indexes at 10^5 Text Changes; selective undo of the first action after 10,000 disjoint ones; startup and restore time; resident memory and disk growth; a 100-run result list with on-demand loading; manuscript responsiveness while parsing is queued.

The real bottleneck is architecture, not arithmetic: chapter granularity, on-demand disk reads, and keeping heavy work off the main thread.

---

## 11 · Milestones

### M0 · Toolchain and gates

Make the conventions executable before the first line of product code.

Deliver: monorepo skeleton, `biome.json`, `tsconfig.json` (TS 7 strict), CI with three gates, the IME gate project.

TypeScript 7 is new enough that build-tool compatibility must be proven, not assumed: run the full TS 7 + Bun + Svelte chain on real `core` code.

Accept: `bun run fmt:check`, `bun run check`, `bun test` all green; the IME gate runs on Windows and produces a report.

Status: gates green (§4.3 records what the chain actually required). The IME gate project has not landed in the repository yet.

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
| Q1 | Product and repository name | Closed — `RefRain`, chosen 2026-07-26. A reference and a refrain; the default theme is 雨. |
| Q2 | May a human and an agent edit the same file concurrently? (Leaning: the file is read-only to the human while an agent works on it) | Open |
| Q3 | UI for cross-session multi-agent dialogue orchestration | Needs design |
| Q4 | Does the Verdict Ledger's retrieval interface ship in v1? | Closed — yes, as `search` over stated reasoning. An earlier answer also promised a compiled taste profile; that was withdrawn. Reducing scattered verdicts to "what this writer wants" is inference, and an application that makes no network calls and holds no model cannot perform it. The ledger informs a persona the author writes; it does not write one. |
| Q7 | An agent's identity is authored, not inferred — a `Persona` the writer edits, with per-agent control over whether it travels every round, only the first, or never. One harness and one model therefore yield several collaborators, distinguished by brief rather than by runtime binding. | Closed — 2026-07-26 |
| Q6 | Does a proposal-level `accept` with no slice verdicts mean "take all of it" or "take none of it"? Today it means none — `rebuildReplacement` counts an unjudged slice as rejected, so the batch reports `ok: true` and changes nothing. Conservative and safe, but a user who clicks Accept and sees no change will read it as a bug. | Open — needs a product call |
| Q8 | A workspace on a volume whose root is not writable cannot have a trash directory created, so the delete fails and the file stays. Measured on Linux with a workspace under `/tmp` while the user's home is on another mount. The failure is correct — falling back to a permanent delete would break the promise the layer exists for — but a writer who meets it has no way to delete from inside the application. Options: offer to move the file to a trash the user can write to, or say plainly that this volume has none. | Open — needs a product call |
| Q5 | The chapter header will not share the manuscript's left edge — it stays at the pane edge regardless of width, `align-self`, or a wrapper element, while the sheet centres correctly. Measured by `apps/desktop/scripts/capture.ts`, which warns rather than fails. | Open |
