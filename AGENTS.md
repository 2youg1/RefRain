# AGENTS.md

A local writing workbench. Every edit an agent proposes is a reviewable object; the manuscript stays under human control.

`SPEC.md` is the authoritative design baseline. When code and SPEC disagree, change the code.

## Setup

```bash
bun install
bun run dev
bun run check      # tsc --noEmit
bun run fmt        # biome, writes
bun test
```

## Before you edit

Read `SPEC.md`, then the target module in full, then its tests. Read a function's callers before changing its signature.

If SPEC does not cover a decision, do not invent one. Append it to SPEC §12 and continue with what you can determine.

## Invariants

Violating any of these is a bug, not a style preference.

1. **No network.** The app process makes no outbound requests. No API keys, no telemetry, no auto-update. Model calls happen only inside the user's own harness.
2. **Only a Text Action mutates the manuscript.** Agent output becomes an immutable Proposal; a human click merges it. No auto-accept, no background merge, no YOLO mode.
3. **No billing math.** Never display prices or cost estimates. Report token counts exactly as the harness reports them, tagged `actual` / `estimated` / `unknown`. When unavailable, show unknown.
4. **Source Backup is never written to.**
5. **`packages/core` has no DOM and near-zero dependencies.** `packages/agent` is the only surface touching a harness; protocol drift stops there. `apps/desktop` holds windowing and packaging only.
6. **The editor core is framework-free.** ProseMirror owns the DOM; Svelte owns the shell. No framework code on the IME path.

## Style

TypeScript 7 strict, ESM, functions over classes.

One line expresses one complete idea. Delete explanatory temporaries, ceremonial control flow, and wrappers that only rename.

An abstraction earns its place by doing one of three things: enforcing an invariant, isolating a likely change, or naming a concept used in composition. If it does none, three similar lines beat a premature abstraction.

Domain vocabulary is single-authority — `Text Head`, `Revision`, `Proposal`, `Review Slice`, `Verdict`, `Edit Scope` (SPEC §2). Use the same word in code, comments, UI strings, and test names. Do not coin synonyms.

Identifiers in English. Comments explain *why*, never *what*. Soft limits: 400 lines per module, one screen per function — exceed them only with a reason you can state.

## Tests

Three gates, all green or the PR does not land:

```bash
bun run fmt:check && bun run check && bun test
```

Most test effort belongs in `packages/core`. Adapters use contract tests against a real session and run (SPEC §6.5).

**Green assertions are not correctness.** Changing UI requires looking at rendered pixels. Changing a protocol requires a real round trip. Bumping Electron requires the `e2e/ime` gate.

The `e2e/ime` gate (Windows + MS Pinyin, four shells, real `SendInput` typing) runs in CI as the `ime-gate` workflow. Locally: `e2e/ime/scripts/prepare.ps1` once, then `e2e/ime/driver/drive.ps1 -Shell e43`, then `node e2e/ime/driver/analyze.js` and `node e2e/ime/driver/assert.js`. It seizes the real mouse and keyboard while running.

## Pull requests

Four parts, none optional: **problem** (symptom and repro), **approach** (trade-offs and what you rejected), **implementation** (a dense diff), **evidence** (all three gates).

One commit does one thing. If it takes more than a sentence to describe, split it.
