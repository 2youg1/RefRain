# AGENTS.md

Working discipline for agents in this repository. Every line here was paid for —
each one names a mistake that actually happened and cost real time.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything. It names the
modules and the words; using a different word for an existing concept is the
fastest way to make a change unreviewable.

## Verification

**Four checks, every time.** `cargo fmt --all --check`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo test --workspace --all-targets`, `bun run
gate`. The Rust three are outside the gate. A doc comment attached to the wrong
function was caught only by clippy while the gate was fully green.

**A gate that has never gone red has proven nothing.** Break what it guards,
watch it fail, read the message, restore. Record the injection in the commit.

**When an injection does not go red, find out which of three things is true**
before touching the assertion: the implementation is fine, the assertion tests
something adjacent, or the fixture makes both branches agree. All three happen.

**Assert on something unique to the target.** Three gates in one session were
green for this reason: a phrase that also appeared in a neighbouring licence, a
function name that was a prefix of the real one, a word that appeared in a
comment inside the function being checked. `grep -c <phrase> <file>` returning
more than 1 means the assertion cannot tell target from neighbour.

**A fixture that holds the tested field constant certifies nothing.** The only
Run round-trip test built its fixture with `edge: None`, so dropping edge
serialisation entirely left every test green.

**Completeness needs a shape that fails to compile when an item is missing.**
`as const satisfies readonly T[]` proves every listed item is valid, not that
every valid item is listed. Use `Record<Union, T>`, or take keys from one.

**A two-way mechanism needs two tests.** "Exact falls back to Loose" went red
when the fallback was removed and stayed green when it was made unconditional —
half the trade was untested.

**Read the API before calling it.** Five wrong signatures in one session, each
of which looked plausible.

**Re-measure a surprising result three times before explaining it.** Four
conclusions in one session were overturned by the author's own follow-up
measurement.

## Measurement

**Measure the total before optimising a part.** Indexing took 22 seconds; the
four timed segments summed to 60ms. The missing 366× was in the commit
semantics between them, not in any segment.

**A threshold gate is an instrument, not a rule to satisfy.** A latency budget
going red led to a correctness defect underneath it. Widening the threshold
would have hidden it permanently.

**Measure an intuition before implementing it.** "Shorter queries are vaguer, so
loosen them" is unimpeachable and false: two-to-five-character queries return
identical results in both modes.

**Translate mechanism into pixels and seconds before ranking work.** A +5.73%
estimation error moved a scrollbar thumb by 0.27px — invisible. A scroll-anchor
failure moved the text by 172.5 screens. The second is five orders of magnitude
worse and was ranked second.

**Count your own processes before blaming the system.** Killing a background
gate does not kill the processes it spawned.

## Documents and comments

**Documentation expires; re-verify against HEAD before relying on it.** Three
items marked "not done" in a handoff were already implemented. This has now
happened in three consecutive sessions.

**A comment claiming an invariant is a gate waiting to be written.** If it is
true, guard it. If it is not, it is a lie with a long half-life.

**A guard belongs on the tier that is actually delivered.** The contract ships in
three tiers; a test proving the `Full` tier explains something reads exactly like
coverage while every round sends `Short`.

**`SKILL.md` is generated.** Regenerate it in the same change:
`cargo run -p refrain-core --example generate_skill_doc -- SKILL.md`. A
hand-kept copy once taught agents `version="1"` while the parser required `"2"`.

## Scope

**Do not do half of something.** A half-migration leaves two authorities and the
next change has to reconcile them.

**A ratchet records a reason, it does not relocate lines.** Fighting one has now
increased the total line count six times.

**Platform numbers do not transfer.** Everything measured here is Linux.
Windows behaviour is not known until it is measured on Windows.

**Verify debug and release separately.** One import was needed by a debug-only
fixture and unused in release.

---

- [README.md](README.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
  [CONTRIBUTING.md](CONTRIBUTING.md) · [ROADMAP.md](ROADMAP.md) ·
  [SKILL.md](SKILL.md) · [LICENSE](LICENSE)
