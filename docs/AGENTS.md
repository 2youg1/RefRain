# Agent rules

Read [ARCHITECTURE.md](ARCHITECTURE.md) before editing. Use its glossary; do not invent a second term for an existing concept.

## Ownership

- Put each invariant in the module that can enforce it. Do not make callers remember it.
- Keep dependencies directed toward `refrain-core`; the core does not depend on another workspace crate.
- Use enums for state machines. Do not add catch-all match arms where a new variant must force review.
- Do not create `utils`, `helpers`, or `common` modules.
- Complete a migration in one semantic change. Remove the old authority and temporary adapters.

## Verification

Run all four checks in this order:

```sh
bun install
bun run gate
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
```

`bun run gate` must run before cargo. The roundtrip corpora under `tests/corpora`
are generated, not committed; `crates/refrain-core/tests/source_layout.rs` reads
them with `include_bytes!` at compile time. On a clean checkout, cargo fails with
`couldn't read .../tests/corpora/*.md` until the gate generates them. Run
`bun run corpora` alone if you want the corpora without the full gate. This order
matches the CI workflow.

A new gate must be injection-verified: break the mechanism it depends on, require a specific red result, restore it, then require green. A missing symbol, fixture, or path must fail closed.

Use fixtures that differ on the field under test. For a two-way mechanism, test both directions. Represent exhaustive sets with a shape that fails to compile when a member is missing.

Measure performance through the production path. Keep platform-specific claims on the platform that produced them.

## Rust

- Return typed errors across module boundaries.
- Match enum variants exhaustively.
- Add a trait only for an existing second implementation or a test seam.
- Run debug and release checks for code with conditional compilation.

## TypeScript

- Keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `noFallthroughCasesInSwitch` enabled.
- Do not use `any`; accept `unknown` at a boundary and narrow it.
- Use discriminated unions instead of independent Boolean state.
- Keep imports static and at the top level.

## Generated and published files

`docs/SKILL.md` is generated from `refrain_core::agent_protocol::skill_doc()`:

```sh
cargo run -p refrain-core --example generate_skill_doc -- docs/SKILL.md
```

Do not edit the generated document by hand. After generation, run `verify:skill-doc-current` and confirm a second generation changes no bytes.

Repository prose is limited to `README.md` and the approved files under `docs/`. Specifications, plans, memos, previews, and audit notes stay outside the repository.

## Links

- [README](../README.md)
- [Architecture and glossary](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Roadmap](ROADMAP.md)
- [Agent protocol](SKILL.md)
- [MPL 2.0 licence](../LICENSE)
