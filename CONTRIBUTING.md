# Contributing

Thank you for considering a change to RefRain.

## Every pull request needs a description a person wrote

Three things, in your own words:

1. **What is the problem?** What goes wrong, for whom, and when.
2. **Why does it matter?** What does the author lose if it stays broken.
3. **How did you change it?** The approach, not a restatement of the diff.

Short is fine. Three honest sentences beat three polished paragraphs.

## Using an agent is welcome — explaining the result is your job

Most of this codebase was written with agents, and we are not going to pretend
otherwise. Use whatever helps you work.

What we ask is this: **before you open the pull request, make the agent explain
what it did until you can restate it yourself.** Not summarise it — restate it,
in your own words, including why the approach is right and what it might break.

This is not a formality. You are the one who will answer questions in review,
and you are the one whose name is on the change. A description you cannot defend
is a description nobody can review, and an unreviewable change is a liability no
matter how green the tests are.

If you cannot explain part of it, say so in the description. "I do not fully
understand why this fixes it" is useful information. A confident explanation of
something you did not verify is not.

## What good looks like here

Read [ARCHITECTURE.md](ARCHITECTURE.md) first — it names the modules and, more
importantly, the words this project uses. Using a different word for an existing
concept is the most common way a change becomes hard to review.

### Gates must be seen to fail

A test or gate that has never been observed going red has proven nothing. Before
you claim something is guarded:

1. Break the thing it guards — delete the check, invert the condition, remove
   the field.
2. Watch the gate go **red**, and read the message. Does it name the actual
   problem?
3. Restore, and watch it go green.

Include what you injected in the commit message. This project has repeatedly
found gates that were green because the assertion was reaching something other
than its target: a phrase that also appeared in a neighbouring comment, a name
that matched a prefix, a fixture that held the tested field constant.

When an injection **does not** produce red, do not adjust the assertion until it
does. Work out which of three things is true first: the implementation is
actually fine, the assertion tests something adjacent, or the fixture makes both
branches agree.

### Four checks, not one

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
bun run gate
```

The Rust checks are outside `bun run gate`. "The gate is green" is not the same
as "this is ready".

### Style

- **Rust**: state machines are enums with no catch-all arm, so a new variant
  breaks compilation everywhere it must be handled. Errors crossing a boundary
  are typed.
- **TypeScript**: `strict`, no `any`. Use `unknown` at boundaries and narrow it.
  State lives in discriminated unions, not in loose booleans.
- **Comments** explain *why*, and are expected to still be true. A comment that
  claims an invariant the code no longer holds is worse than no comment — if you
  find one, fixing it is a welcome change on its own.
- No `utils`, `helpers`, or `common` module.

### Things that are not up for change without discussion

These have gates, and a pull request that breaks one will fail:

- The application process makes **no network requests**.
- **Only a human click** merges text into a manuscript.
- `.refrain-source/` is **never written to**.
- Deleting moves to the recycle bin.
- `SKILL.md` is generated. Regenerate it; do not hand-edit it.

If you believe one of these is wrong, open an issue and argue the case. That is
a real conversation to have — just not inside a pull request that also changes
twenty files.

## Reporting a bug

Say what you did, what happened, and what you expected. If it involves a
manuscript, the size matters (how many blocks, how large the file). If it
involves an agent, tell us which harness.

A reproduction we can run is worth more than a careful description, and a
careful description is worth a great deal.

## Licence

By contributing you agree that your contribution is licensed under
[MPL 2.0](LICENSE), the same terms as the project.

---

- [README.md](README.md) — what RefRain is
- [ARCHITECTURE.md](ARCHITECTURE.md) — modules, glossary, and where problems live
- [ROADMAP.md](ROADMAP.md) — what is planned
- [AGENTS.md](AGENTS.md) — working discipline for agents
