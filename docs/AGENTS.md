# Agent rules

Read [ARCHITECTURE.md](ARCHITECTURE.md) before editing. Use its glossary; do not
invent a second term for an existing concept.

## Before any code

If you cannot follow these rules, do not add a line of code.

Every new feature starts in [ARCHITECTURE.md](ARCHITECTURE.md), not in a source
file. Before you edit, find the module there and fix its position on three
axes:

- **its layer** — which layer owns it (see "The Native layers" below);
- **its event flow** — the full path from the author's action to the answer;
- **its neighbours** — the other modules the change touches.

If the feature is not in the document, prove it is necessary and add it first:
the module, its layer, the invariant it owns, and its event flow. Then land
the code and the document update in the same commit. A feature that exists
only in code is invisible to the next reader, and the document becomes a
second, stale authority.

## Understand before you produce

You are spending someone else's token budget. Spend it on understanding, not on
producing.

1. **Read the code before you write any.** Find what already exists, what owns
   the invariant you care about, and what the surrounding code looks like. Most
   requested features are already half-built somewhere in this repository.
2. **Run a few probes.** A ten-line probe that measures the real behaviour beats
   an hour of reasoning about it. Two measured examples from this repository: the
   line-break cost fell 92% because someone timed it instead of guessing; the
   request cache-prefix rose from 1.1% to 53% because someone counted the shared
   bytes instead of trusting a comment that said "stable order".
3. **Work the logic until it is clear, then find the smallest change.** The best
   change is often deleting a second authority, moving three lines, or reordering
   an existing sequence. If your plan adds a module, say which invariant it owns.
4. **Write code that reads like the code around it, or write no code at all.**
   Match the surrounding naming, error handling, and comment style. New code that
   looks foreign is a maintenance cost even when it is correct.
5. **Do not add tests that cannot fail.** One discriminating test beats five
   restatements of the implementation. Prove a new gate can go red before you
   claim it guards anything.

## Ownership

- Put each invariant in the module that can enforce it. Do not make callers remember it.
- Keep dependencies directed toward `refrain-core`; the core does not depend on another workspace crate.
- Use enums for state machines. Do not add catch-all match arms where a new variant must force review.
- Do not create `utils`, `helpers`, or `common` modules.
- Complete a migration in one semantic change. Remove the old authority and temporary adapters.

## Reuse before writing

Find the existing authority before you add one. Checked by review, not by a gate.

1. **Search this repository first.** A rule, a guard, or a derivation usually
   exists already. `ConfigChange` is the whole settings vocabulary;
   `ProjectStore::document_file` already owns containment and INV-4;
   `refrain_core::typeset` already owns line breaking.
2. **Search the Native SDK second.** It ships 70 markup elements
   (`primitives/canvas/ui_schema.zig`) and a design-token theme system. Use the
   library composite and theme it; `native eject component <name>` transfers
   ownership only when you must own the shape. Engine controls — button, text
   field, tabs — never eject: change them through tokens.
3. **Read the vendor's source, not its documentation.** Two measured cases:
   the SDK draws only circular corners, so RefRain keeps its own superellipse;
   the SDK already flips and clamps anchored surfaces, so RefRain deleted its
   own placement code. Documentation answered neither question.
4. **Design a new capability for more than its first caller.** State which
   invariant it owns and which callers compose it. A capability with one call
   site and no invariant is a rename, not a module.

## Comments

Required on new features and on interface code. Checked by review, not by a gate.

A comment states three things and stops:

- **what it connects to** — which feature this serves;
- **what it owns globally** — the invariant or decision that lives here;
- **what can be reused** — what a caller may build on.

On an interactive surface, a comment also states the interaction design: which
key does what, which layer closes first, what the author sees after each
action, and which decisions are deliberate (with their reason, or the version
they came from). A later change must be able to tell intent from accident
without reading the whole file.

Keep it readable at a glance. Do not narrate syntax. Record a measurement or a
correction that the code cannot state itself — `corners.zig` keeps
"n = 4.2 is G3.2, not G4" because rewriting the module would lose it.

## Verification

Run these in order. The order is load-bearing; see below.

```sh
bun install
bun run scriptc:build    # tier A gates run as compiled binaries
bun run gate
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
mkdir -p .tmp
TMPDIR="$PWD/.tmp" cargo test --workspace --all-targets
```

`bun run scriptc:build` must run before `gate`: the tier A gates execute the
compiled artifact, so a source change that is not rebuilt leaves the gate
testing the previous binary. A missing artifact fails the gate; it never falls
back to the interpreter.

`bun run gate` must run before cargo. The roundtrip corpora under `tests/corpora`
are generated, not committed; `crates/refrain-core/tests/source_layout.rs` reads
them with `include_bytes!` at compile time. On a clean checkout, cargo fails with
`couldn't read .../tests/corpora/*.md` until the gate generates them. Run
`bun run corpora` alone if you want the corpora without the full gate. This order
matches the CI workflow.

The recycle-bin tests need a `TMPDIR` the desktop trash service can write to. On
a Linux host whose `/tmp` sits on a separate mount, `trash` targets
`/.Trash-1000` and three `refrain-store` tests fail with `PermissionDenied`.
Point `TMPDIR` at a writable directory first:

```sh
TMPDIR=$PWD/.tmp cargo test --workspace --all-targets
```

A new gate must be injection-verified: break the mechanism it depends on, require a specific red result, restore it, then require green. A missing symbol, fixture, or path must fail closed.

Use fixtures that differ on the field under test. For a two-way mechanism, test both directions. Represent exhaustive sets with a shape that fails to compile when a member is missing.

Measure performance through the production path. Keep platform-specific claims on the platform that produced them.

## Rust

- Return typed errors across module boundaries.
- Match enum variants exhaustively.
- Add a trait only for an existing second implementation or a test seam.
- Run debug and release checks for code with conditional compilation.

## TypeScript

**Read [EFFECT.md](EFFECT.md) before you write or review any TypeScript.** It
holds the compiler settings, the type discipline, the territory map, and the five
canonical patterns. This file does not repeat them.

Two rules live here because they are not Effect's business:

- The Native core subset (`apps/native/src/core.ts`) is not ordinary TypeScript.
  See "The Native layers" below for what it can and cannot express.
- Do not write JavaScript by hand.

## The Native layers, and what each may hold

Enforced by `native check . --strict` and by review.

| Layer | Holds | Never holds |
|---|---|---|
| Rust (`refrain-app`, `refrain-core`) | Manuscript bytes, block identity, revision, config, every product rule | — |
| C ABI + generated protocol | Memory layout, offsets, error codes, fingerprint | Product action semantics; those are Rust enums |
| Zig (`apps/native/src/*.zig`) | Platform events, immutable projections, drawing, non-ASCII labels | A second copy of the text, selection, composition, or undo state |
| TypeScript core (`core.ts`) | Interface state, stable identifiers, revision | Manuscript bytes; a document state machine |
| Markup (`app.native`) | Structure and event bindings | Logic |

Two limits the checker enforces, both of which move code to its right owner:

- The core subset folds numbers, strings, `asciiBytes` literals, array tables
  and interface-annotated record tables. An `as const` string table fails
  `NS9001`; a Chinese label belongs in a Zig table beside the theme colours.
- The core subset has no `Number()`. Parsing a key name into an ordinal is the
  platform event layer's work, so the core receives the ordinal.

A model field or `Msg` that only Zig reads must be listed in `viewUnbound`
with the reason. The checker fails on an unlisted one.

## Generated and published files

Generated by a script; edit the template, never the output:

| File | Generator |
|---|---|
| `apps/native/src/generated/protocol.{ts,zig}`, `crates/.../protocol.rs`, `refrain_native.h` | `scripts/generate-native-protocol.ts` |
| `apps/native/src/generated/themes.zig` | `scripts/generate-themes.ts` |
| `docs/SKILL.md` | `refrain_core::agent_protocol::skill_doc()` |

`bun run fmt` reorders generated files and drifts the protocol. Re-run the
generator after formatting, then `bun scripts/generate-native-protocol.ts --check`.

`docs/SKILL.md` is generated from `refrain_core::agent_protocol::skill_doc()`:

```sh
cargo run -p refrain-core --example generate_skill_doc -- docs/SKILL.md
```

Do not edit the generated document by hand. After generation, run `verify:skill-doc-current` and confirm a second generation changes no bytes.

Repository prose is limited to `README.md` and the approved files under `docs/`. Specifications, plans, memos, previews, and audit notes stay outside the repository.

## Links

- [README](../README.md)
- [Architecture and glossary](ARCHITECTURE.md)
- [Effect conventions](EFFECT.md)
- [Contributing](CONTRIBUTING.md)
- [Agent protocol](SKILL.md)
- [MPL 2.0 licence](../LICENSE)
