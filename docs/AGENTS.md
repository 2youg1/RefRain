# Agent rules

The binding rule set for every agent change in this repository. Read
[ARCHITECTURE.md](ARCHITECTURE.md) before editing. Use its glossary; do not
invent a second term for an existing concept.

Session state — handoffs, plans, memos, probe results — lives outside the
repository, in the sibling directory `../RefRain-work/`. Start a session by
reading its `Handoff.md`; end one by rewriting it.

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

## Licence notice

Every distributed file opens with the MPL 2.0 Exhibit A notice and the
copyright line under it, in that file's comment syntax, ahead of everything
except a byte-order mark or a shebang. The notice leads because Sec. 3.4
forbids altering the substance of a licence notice, so those three rows are the
part that must stay verbatim and unsplit. Exhibit A permits the added copyright
line and names no owner itself, so without it a recipient reads the terms
without the party offering them; it reads "and the RefRain contributors"
because contributors hold copyright in what they write, and a standing class
spares every header a rewrite when the first outside contribution lands. The
licence attaches through the notice and only through it: MPL 2.0 Sec. 1.4
defines Covered Software as Source Code Form "to which the initial Contributor
has attached the notice in Exhibit A". A file without the notice is not a
violation — it is a file whose licence a recipient cannot determine, while
`Cargo.toml`, `package.json`, and `README.md` all claim MPL 2.0 for it.

`scripts/licence-notice.ts` owns the wording, the comment syntax for each file
family, and the recorded reason for each family that carries no notice. Do not
retype the copyright line or the notice anywhere else. `bun run licence:headers` attaches every
missing notice in place; `verify:licence-headers` goes red on a distributed
file that lacks one, and on a file family the table has never ruled on — so a
new language in the tree forces the decision instead of silently skipping it.

The whole tree shipped through v0.0.2 with no notice in any file. That is why
the rule has a gate and not a paragraph: nobody omits the notice deliberately,
and no reviewer reads three hundred file heads.

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
Point `TMPDIR` at a writable directory first.

A local green gate is not CI green. Four lanes run in CI that `bun run gate`
does not run locally; run them before claiming CI will pass:

```sh
bun scripts/prove-gates-bite.ts                        # CI Linux only
cargo clippy --workspace --all-targets -- -D warnings  # --workspace matters
cargo fmt --all --check
bun scripts/generate-native-protocol.ts --check && git diff --exit-code -- apps/native/src/generated
```

A new gate must be injection-verified: break the mechanism it depends on, require a specific red result, restore it, then require green. A missing symbol, fixture, or path must fail closed. A new gate also enters `scripts/gate.ts` stages, and — if ScriptC compiles it — `scriptc-tiers.ts` `TIER_A`, or `verify:scriptc-coverage` goes red.

Use fixtures that differ on the field under test. For a two-way mechanism, test both directions. Represent exhaustive sets with a shape that fails to compile when a member is missing.

Measure performance through the production path. Keep platform-specific claims on the platform that produced them.

### What green does not prove

Four ways this repository has shipped a green build that failed the author.
Each rule binds every future change; the scar beside it proves it is not
hypothetical. Do not weaken or remove a rule here without recording, in the
same commit, the evidence that its failure mode can no longer occur.

1. **Unit-green modules can compose into a broken window; assert the composed
   result.** When a consumer combines values from two modules, take them from
   one call, and give the change one assertion on what the window shows after
   composition. Scar: `layeredBody` drew `fittingDepth(...)` layers while
   `visibleLayerAt` placed layers against the unclamped `visibleDepth` — both
   modules unit-green, and the page the author had just navigated to was the
   one clipped out of the window.

2. **Assert what the author sees, not what the function returns.** A change to
   navigation, notices, or any view is accepted by a real-window snapshot
   predicate — "the destination's heading is visible", "the rejection text is
   readable" — never only by the returned variant. Scar: `navigate` returned
   `needs_document` correctly under test while the notice rendered as an empty
   grey strip the author could not read.

3. **List every path the lanes short-circuit, and walk each one in a real
   window before a release claim.** `REFRAIN_AUTOMATION_ROOT` answers every
   rfd file dialog in every automated lane, so no lane has ever opened the
   real dialog. Scar: the import and open-project buttons shipped dead; every
   lane stayed green because none could reach the dialog they bypass.

4. **The release predicate is the author's flow in a real window, not the
   gate count.** Before any tag: drive the built binary through adopt →
   document rows visible → open a manuscript → type → save → reach every
   destination → read every rejection. This extends the standing rule ("the
   artifact must run on this machine before a tag") from booting to using.

## The Native layers, and what each may hold

Checked by `bun run check` and by review. The TypeScript core and the `.native`
markup view died in unit 13; the application surface is Zig over a Rust
staticlib. Do not resurrect either dead layer.

| Layer | Holds | Never holds |
|---|---|---|
| Rust (`refrain-app`, `refrain-core`, `refrain-store`, `refrain-host`) | Manuscript bytes, block identity, revision, config, every product rule | — |
| C ABI + generated protocol (`apps/native/src/generated/`, `crates/.../protocol.rs`) | Memory layout, offsets, error codes, fingerprint | Product action semantics; those are Rust enums |
| Host staticlib (`apps/native/host/`) | The one `unsafe` seam, rfd dialogs, synchronous dispatch into `refrain-app` | Domain rules |
| Zig core (`apps/native/src/core.zig`, `src/core/`) | Model, Msg, update, destinations, reply slots | A second copy of the text, selection, composition, or undo state |
| Zig views (`apps/native/src/view/`, `app_main.zig` routing) | Drawing and Msg dispatch, non-ASCII labels | State mutation; a rule the core or Rust already owns |

Operational facts the build system does not confess:

- A new Zig module must be added to the `refAllDecls` block in `app_main.zig`,
  or its tests silently never run while every lane stays green.
- A real-window probe needs a `-Dautomation=true` build; without it the
  automation channel does not exist and the probe reports missing widgets.
- The automation channel follows the process working directory: launch
  `refrain.exe` with `cwd = apps/native`.
- Run one window lane at a time; they share one automation publisher.

## Rust

- Return typed errors across module boundaries.
- Match enum variants exhaustively.
- Add a trait only for an existing second implementation or a test seam.
- Run debug and release checks for code with conditional compilation.

## TypeScript

TypeScript is the gate, script, and e2e layer only; application code is Zig
and Rust. **Read [EFFECT.md](EFFECT.md) before you write or review any
TypeScript.** It holds the compiler settings, the type discipline, the
territory map, and the canonical patterns. Do not write JavaScript by hand.

## Generated and published files

Generated by a script; edit the template, never the output. Every file here
opens with the MPL notice and carries `@generated` on the line directly below
it, and this table must name all of them: the row that is missing is the file
somebody hand-edits. `themes.zig` announced its generator in prose and carried
no marker at all until the notice sweep gave every head one shape — the table
listed it the whole time, which is what a table can and cannot prove.

| File | Generator |
|---|---|
| `apps/native/src/generated/protocol.{ts,zig}` | `scripts/generate-native-protocol.ts` |
| `apps/native/src/generated/wire.zig` | `scripts/generate-native-protocol.ts` |
| `apps/native/host/src/protocol.rs` | `scripts/generate-native-protocol.ts` |
| `apps/native/host/src/wire.rs` | `scripts/generate-native-protocol.ts` |
| `apps/native/host/include/refrain_native.h` | `scripts/generate-native-protocol.ts` |
| `apps/native/src/generated/themes.zig` | `scripts/generate-themes.ts` |
| `docs/SKILL.md` | `refrain_core::agent_protocol::skill_doc()` |

The two `wire` files and `protocol.rs` sit beside hand-written code rather than
under a `generated/` directory, so the directory name cannot warn anybody. This
table listed three of the six and gave `crates/.../protocol.rs`, a path that
exists nowhere — the generator writes `apps/native/host/src/protocol.rs`. The
`--check` stage catches a hand edit, but it catches it after the edit is
written; the list is what prevents it.

`bun run fmt` reorders generated files and drifts the protocol. Re-run the
generator after formatting, then `bun scripts/generate-native-protocol.ts --check`.

`docs/SKILL.md` is generated:

```sh
cargo run -p refrain-core --example generate_skill_doc -- docs/SKILL.md
```

Do not edit the generated document by hand. After generation, run `verify:skill-doc-current` and confirm a second generation changes no bytes.

Repository prose is limited to `README.md`, the approved files under `docs/`,
and the two root pointer stubs: `AGENTS.md` (a three-line pointer for
non-Claude harnesses) and `CLAUDE.md` (an `@docs/AGENTS.md` import, which
inlines this file for Claude Code — keep it that one import plus the
session-state line). Specifications, plans, memos, previews, and
audit notes stay outside the repository, in `../RefRain-work/`.

## Links

- [README](../README.md)
- [Architecture and glossary](ARCHITECTURE.md)
- [Effect conventions](EFFECT.md)
- [Contributing](CONTRIBUTING.md)
- [Agent protocol](SKILL.md)
- [MPL 2.0 licence](../LICENSE)
