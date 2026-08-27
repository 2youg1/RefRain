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

## Before you push: look at what you are about to publish

RefRain is a writing tool. The files it touches are manuscripts, notes, and
research — the most private things on an author's disk. A contributor debugging
a real problem is usually debugging it against **their own writing**, and that
is exactly when a stray file gets committed.

Run this before every push:

```sh
git status --short          # anything untracked you did not mean to add?
git diff --cached --stat    # what is actually staged?
git diff --cached           # read it — every line
```

Then ask three questions about the diff:

1. **Is any of this my own text?** A manuscript, a note, a paragraph pasted into
   a fixture. Test fixtures must be written for the test, not lifted from real
   writing.
2. **Does any of it name a real path?** `/Users/yourname/...`,
   `C:\Users\...`, a project folder, a client's name in a filename. Absolute
   paths leak both your identity and your directory layout, and they only
   resolve on the machine that wrote them.
3. **Is there a credential, token, or key?** Including in a screenshot, a log
   excerpt, or a pasted error message.

A commit is not the last chance to catch this. **Git history keeps what you
remove in a later commit**, so a file deleted in the next commit is still
published. If you have already pushed something private, say so immediately —
rewriting history and rotating a leaked credential both work, and both work far
better within the hour.

What must never enter the repository:

| Never commit | Why |
|---|---|
| Your own manuscripts, notes, or research | They are yours; a fixture should be written for the test |
| `.refrain/` or `.refrain-source/` from a real project | Application state and the untouched backup of someone's writing |
| Absolute paths from your machine | Leaks your identity and layout, and resolves nowhere else |
| Tokens, keys, passwords | Including inside logs, screenshots, and error output |
| Any Markdown not in the published set | `verify:no-spec-upload` is an allowlist; a new `.md` fails until someone adds it deliberately |
| Local design or planning documents | `SPEC.md`, memos, audit notes — the most common case of the row above |
| Generated review artifacts | Preview pages and screenshots. The script that rebuilds them belongs in the repository; the output does not |

The `.gitignore` covers the known cases, and `verify:no-spec-upload` enforces
the rest as an **allowlist**: every Markdown file in the repository must be
named in that gate's `PUBLISHED` list. A document you did not mean to add fails
the gate rather than reaching the history — you do not have to remember the
rule, and neither does a reviewer.

That allowlist is the reason a contributor cannot publish a manuscript by
accident. What it cannot catch is private text pasted *inside* a file that is
already published — a real paragraph used as a test fixture, a real path in an
error message. That part is the reading above, and it cannot be automated.

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
bun install
bun run gate
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
```

Run the gate first. The roundtrip corpora under `tests/corpora` are generated by
`scripts/freeze-corpora.ts` and are not committed, and
`crates/refrain-core/tests/source_layout.rs` reads them with `include_bytes!` —
at compile time, not at test time. On a clean checkout, cargo therefore stops at
`couldn't read .../tests/corpora/ideographic-indent.md` before a single test
runs. `bun run gate` generates them as its first step, which is also why CI never
saw this. `bun run corpora` does the generation on its own.

The recycle-bin tests need a `TMPDIR` the desktop trash service can write to.
Deletion goes to the system recycle bin and never silently downgrades to a
permanent delete, so on a Linux host whose `/tmp` is a separate mount the trash
service targets `/.Trash-1000` and three `refrain-store` tests stop with
`PermissionDenied`. That is the platform, not the code:

```sh
TMPDIR=$PWD/.tmp cargo test --workspace --all-targets
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
[MPL 2.0](../LICENSE), the same terms as the project.

A new file opens with the copyright line and the Exhibit A notice, in its own
comment syntax. Run `bun run licence:headers` and both are attached for you;
`verify:licence-headers` fails the gate if you forget. The Exhibit A lines are
what MPL 2.0 Sec. 1.4 reads to decide whether a file is covered, so a file
without them is a file whose licence nobody can state.

---

- [README.md](../README.md) — what RefRain is
- [ARCHITECTURE.md](ARCHITECTURE.md) — modules, glossary, and where problems live
- [AGENTS.md](AGENTS.md) — working discipline for agents
