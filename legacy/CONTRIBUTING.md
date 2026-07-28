# Contributing

The manuscript stays under human control. Every rule below follows from that.

## Setup

```bash
bun install
bun run native     # cargo build + copy the platform binary into packages/fs
bun run gate       # fmt:check, tsc, bun test — all three or it does not land
```

`bun run native` needs a Rust toolchain and a system C compiler. Without `cc`,
`source scripts/native-env.sh` points cargo at Zig, which ships a complete C
toolchain in one relocatable tarball. CI needs none of this.

The file layer is a build artefact. Without it the application still opens,
edits, saves and reviews — it loses the file browser and says which platform
lacks a build.

## Before you write code

Read `SPEC.md`. It is the authority: when the code disagrees with it, the code
is wrong. If SPEC does not cover your decision, do not invent one — append the
question to SPEC §12 and proceed with what you can determine.

Then read the module in full, and its tests, and the callers of any function
whose signature you intend to change.

## Writing an adapter

An adapter lives in `packages/agent` and touches nothing else; protocol drift
stops there. `CommandAdapter` covers any harness with a command-line entry
point in about a template's worth of code — start there and see whether you
need more.

Reaching L2 requires contract tests against a real session and a real run
(SPEC §6.5). A tier is a claim about evidence, so an adapter stays at L1 until
that evidence exists. Claude Code is currently L1 for exactly this reason.

## Tests

```bash
bun run gate
```

Most test effort belongs in `packages/core`. The native layer has its own
suite — `cd packages/fs && cargo test` — which runs against the real
filesystem, because a Windows path rule and a macOS trash binding cannot be
tested any other way.

**Green assertions are not correctness.** Changing the interface means looking
at rendered pixels. Changing a protocol means a real round trip. Bumping
Electron means the `e2e/ime` gate on Windows with a real input method.

One lesson worth stating, because it shipped: `bun test` runs under Bun, and
the packaged main process runs under Node. A `Bun.spawn` in the main process
passed every test and crashed for every user. If your change spans a runtime
boundary, exercise it on the runtime that ships.

## Pull requests

Four parts, none optional:

- **Problem** — the symptom, and how to reproduce it.
- **Approach** — the trade-off, and what you rejected.
- **Implementation** — a dense diff.
- **Evidence** — all three gates, plus whatever the change specifically
  requires (pixels, a round trip, the IME gate).

One commit does one thing. If describing it takes more than a sentence, split
it.

## Licence

The project is GPL-3.0. The bundled typefaces are licensed separately, under
their own terms; see `apps/desktop/src/renderer/fonts/LICENSES.md`. A
contribution is made under the same licence as the project.
