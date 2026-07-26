# AGENTS.md

A local writing workbench. Every edit an agent proposes is a reviewable object; the manuscript stays under human control.

`SPEC.md` is the authoritative design baseline. When code and SPEC disagree, change the code.

## Setup

```bash
bun install
bun run native     # cargo build + copy the platform binary into packages/fs
bun run dev
bun run check      # tsc --noEmit
bun run fmt        # biome, writes
bun test
```

`bun run native` needs a Rust toolchain and a system C compiler. On a machine
without `cc`, `source scripts/native-env.sh` first — it points cargo at Zig,
which ships a complete C toolchain in one relocatable tarball. CI needs none of
this; GitHub's runners already carry MSVC, clang, and gcc.

The file layer is a build artefact, so `packages/fs/test/boundary.test.ts`
skips when the binary is absent and says so rather than reporting green.

## Before you edit

Read `SPEC.md`, then the target module in full, then its tests. Read a function's callers before changing its signature.

If SPEC does not cover a decision, do not invent one. Append it to SPEC §12 and continue with what you can determine.

## Invariants

Violating any of these is a bug, not a style preference.

1. **No network.** The app process makes no outbound requests. No API keys, no telemetry, no auto-update. Model calls happen only inside the user's own harness.
2. **Only a Text Action mutates the manuscript.** Agent output becomes an immutable Proposal; a human click merges it. No auto-accept, no background merge, no YOLO mode.
3. **No billing math.** Never display prices or cost estimates. Report token counts exactly as the harness reports them, tagged `actual` / `estimated` / `unknown`. When unavailable, show unknown.
4. **Source Backup is never written to.** Every mutating call in `packages/fs` passes through `Guard::admit`, which refuses it along with any path outside a workspace root. `bun run verify:trash-only` fails the build if a route around the guard appears.

4b. **Delete goes to the system trash.** There is no permanent delete at any layer — not in Rust, not across N-API, not as an IPC channel. When the trash is unavailable the operation fails and the file stays; falling back to `remove_file` would turn an inconvenience into the one loss this application promises never to cause.
5. **`packages/core` has no DOM and near-zero dependencies.** `packages/agent` is the only surface touching a harness; protocol drift stops there. `packages/fs` is the only surface holding a platform binary; native and OS-specific risk stops there. `apps/desktop` holds windowing and packaging only.
6. **The editor core is framework-free.** The manuscript is a `contenteditable` holding paragraph elements, driven directly rather than through Svelte's reactivity — no framework code sits on the IME path. ProseMirror goes underneath in v0.2, under the same rule.

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

Most test effort belongs in `packages/core`. Adapters use contract tests against a real session and run (SPEC §6.5). The native file layer has its own suite — `cd packages/fs && cargo test` — which runs against the real filesystem of whichever platform it is on, because a Windows path rule and a macOS trash binding cannot be tested any other way.

**Green assertions are not correctness.** Changing UI requires looking at rendered pixels. Changing a protocol requires a real round trip. Bumping Electron requires the `e2e/ime` gate.

The `e2e/ime` gate (Windows + MS Pinyin, four shells, real `SendInput` typing) runs in CI as the `ime-gate` workflow. Locally: `e2e/ime/scripts/prepare.ps1` once, then `e2e/ime/driver/drive.ps1 -Shell e43`, then `node e2e/ime/driver/analyze.js` and `node e2e/ime/driver/assert.js`. It seizes the real mouse and keyboard while running.

## Pull requests

Four parts, none optional: **problem** (symptom and repro), **approach** (trade-offs and what you rejected), **implementation** (a dense diff), **evidence** (all three gates).

One commit does one thing. If it takes more than a sentence to describe, split it.
