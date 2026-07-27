# Roadmap

*[中文版](ROADMAP.zh-CN.md)*

---

## Shipped — v0.1.6

The manuscript held up in v0.1.5. This release is about the evidence — the
gates that were supposed to prove it, several of which were not proving
anything.

**A gate that stopped looking now says so.** Two invariant guards scanned by
literal path. A refactor moved the code they watched, and both quietly degraded
to `exit 0` — green forever, watching an empty set. They now count what they
scanned and fail when the count is zero. A third script had never been called
by any workflow at all, and had been failing unnoticed for two releases. The
gate list on disk and the gate list in CI are now compared by a gate.

**Every stubbed bridge answers what the real one answers.** Twenty-one render
gates each hand-wrote a stand-in for the preload bridge, and none was complete.
A method a stub forgot was `undefined` at call time, so the component took its
empty branch and the gate reported PASS on a screen no user would ever see. One
gate failed exactly this way, and the failure read as a missing feature. The
stubs now share one base, and a gate keeps the base level with preload.

**The law is tested, not four examples of it.** SPEC §7.4 ends with an
algebraic claim — merging disjoint proposals commutes — and 387 tests, every
one an example, gave it no coverage. Four properties now generate the pairs
instead of naming them. The fourth exists because the first three did not earn
their green: disabling the conflict branch entirely left all three passing,
since generating disjoint scopes by construction means never reaching it.

**A moved sentence is not a formatting change.** The edit log aligned text one
way and the review engine another, so a paragraph the author had reordered
could be described as whitespace. Both now use the alignment the edit log
already had, and an insertion chain lands in chain order rather than
declaration order.

**A gate held under an exemption was measuring a blank screen.** The chapter
header was recorded as sitting 289px off the manuscript it names — twice in the
design baseline, once as a layout defect and once as a measurement fault
awaiting a remeasure — and its gate ran in CI under `continue-on-error`, so the
red never stopped anything. There is no drift. The fixture had never opened:
its command-panel search typed the welcome screen's wording rather than the
command's, and its stub returned a shape the rail could not group. Header and
sheet share a left edge to the pixel. The exemption is gone.

**Typography and theme live in one place.** Chinese and Japanese were setting
each other's stacks — a Japanese face was reaching Chinese text through a
shared fallback. Each language now has its own stack, and the theme owns the
paper: eight themes light the paper they are made of rather than a white that
was the same in all of them.

**A command that arrives with a project asks first.** A project could carry an
agent definition, and opening it was enough to run that command. Trust is now
granted per agent, and the harness receives what it needs and nothing it could
leak.

**Judgments survive the panel closing.** Staged verdicts lived inside a sheet
that unmounts on Escape, so a reader who judged several slices and glanced back
at the paragraph found an empty list on reopening. The same component cleared
them before the merge it was asked to perform.

**A shortcut deletes the link, not the chapter.** `trash` already knew this;
the escape hatch beside it, for a volume that has no trash of its own, did not.
It resolved the path first, so staging a shortcut to chapter three moved
chapter three onto another volume. Its cross-device fallback then dereferenced
the link a second time while copying. Admission now validates both the entry as
written and what it points at, and a copy recreates a link as a link.

**A Root the author never opened stops being a warning.** Permission and
filesystem identity were one question asked at one moment, so cleaning a drive
and reopening RefRain produced one refusal per vanished project. Holding a
permit is now an in-memory answer; identity is verified before anything is
written inside that Root, which is where it matters.

**The file layer is retried, not written off.** The reason a load failed was
cached for the life of the session — a volume mounted afterwards, or a platform
binary installed after launch, meant restarting the application to recover from
a condition that had already cleared.

**Nothing runs forever.** Both harness adapters shipped with their timeout
disabled, because every construction site left it unset, so a hung harness held
its Run in `dispatched` for the session and the Proposals it was carrying never
arrived.

**A Root notices when it changes underneath.** A chapter added by another
editor, a branch checkout, a file dropped into the folder: none of it appeared
until something else happened to trigger a rescan. One watcher per Root now
reports it, ignoring the application's own state directories so a save does not
announce itself as somebody else's edit.

**Removing a Root asks first**, and the control it asks about is visible to a
keyboard — it was revealed on hover alone, so tabbing through the rail landed
on a button at zero opacity.

**A Proposal stays with the chapter it was written against.** Switching
chapters kept them, so the review panel offered a merge whose scope named text
no longer on screen.

**Settings refuse what would break the page.** Clearing the size box to retype
it reads back as zero, and the manuscript collapsed to 0px under the author; a
font name went into a `style` attribute, where a quote closes the string and a
semicolon starts a new declaration.

**念頭寄存 has somewhere to put a thought.** A stray thought caught
mid-sentence is a judgment about the work, so it lives in the Verdict Ledger,
carrying the chapter and block the author was standing in. Two things can be
done with one — return to it, or drop it. It is deliberately not a task system.

**Three documents stopped describing an application that does not exist.** The
specification named two typefaces that were never packaged; the flow document
taught eight adjudication chords that had been deleted, and a dead binding
shadows whatever the author rebinds to that chord; a stylesheet set CJK
emphasis in italic, which the manuscript — a plain-text surface — had never
rendered at all.

**14MB of regenerable screenshots left the repository**, along with a check
nobody had ever called and the dependency it existed to use.

## Shipped — v0.1.5

Windows x64. One author, several local folders, any harness, chapterised
Markdown.

This release is about the manuscript surviving contact with the application.

**Bytes you did not write stay as you left them.** Opening a file and saving it
with no edit at all used to lose bytes: the ideographic indent that opens a
Chinese paragraph was deleted on load, a fenced code block was cut in two by
the blank line inside it, and consecutive blank lines collapsed. A file now
parses into blocks that remember where they sit in the original, and saving
replaces only the ranges whose text actually changed. This is a lower bound,
not lossless Markdown — a paragraph you rewrite is rewritten — and it is
enforced by `verify:roundtrip` over twenty corpora.

**Typing Chinese waits for the input method.** The renderer had no notion of
composition, so Ctrl+S mid-word wrote half-formed pinyin to disk as prose, and
a redraw arriving during composition tore out the node the input method was
composing into. A save asked for mid-composition is now deferred, not refused.
The surface also stopped collapsing whitespace, so an indent is visible as an
indent.

**Saving a long book costs what the change costs.** A 40,000-block manuscript
threw `RangeError: Out of memory` on any save, because the alignment table is
allocated before anything is compared. Correcting one character in a 20,000
block manuscript took 5.2 seconds; it now takes 5.5 milliseconds, and 100,000
blocks complete in every mutation shape that used to crash.

## Shipped earlier — v0.1.3

Windows x64, Linux x64, macOS arm64 and x64. One author, several local folders,
any harness, chapterised Markdown.

The path a release must complete, and does:

```
open a folder -> write -> select a range, write an instruction, pick an agent
-> queue it -> send the batch with one click
-> the harness runs and writes a Result Artifact
-> the app freezes Proposals and Review Slices -> the human adjudicates
-> a Decision Batch produces a new Text Head -> the verdict enters the ledger
```

Also in the application now: several workspace roots and single-file open; a
record of every edit with per-change revert; a command palette as the only
permanent control; eighteen typographic controls with Chinese and Latin faces
set separately; five bundled OFL typefaces; rebindable keys; ruled lines that
land under the glyphs; line numbers, a minimap, and a progress gradient; an
agent panel that reports whether a harness is actually reachable.

**A native file layer** (`packages/fs`): traversal, search, sort and a delete
that goes to the system trash and has no permanent variant at any layer. Rust
through N-API, built on the platform that will run it.

## Known limits

Stated rather than filed, because a user meets them on the first day.

**Not verified on real hardware.** CI builds and launches on all four targets,
but the Windows IME gate (`e2e/ime`) needs a real display and a real input
method, and the macOS trash binding needs a real Mac. Neither result may be
inferred from a Linux runner.

**Claude Code is L1, not L2.** Its protocol and lifecycle are covered by
process tests. SPEC §6.5 requires a real session and a compaction signal before
an adapter may claim L2, and that evidence does not exist yet.

**Deleting can fail on a volume without a writable trash.** The freedesktop
specification cannot create `.Trash-<uid>` if the volume root is read-only. The
operation fails and the file stays where it is; the interface says so. Falling
back to permanent deletion would defeat the reason this layer exists.

**Releases are unsigned.** Windows SmartScreen and macOS Gatekeeper will warn.

**Accepting a whole proposal without judging its slices does nothing useful.**
Tracked as SPEC §12 Q6; the product decision is open.

## Next — v0.2

**A real editor core.** The manuscript is currently a `contenteditable` holding
paragraph elements. That is enough for prose and not enough for selective undo
across 10,000 actions, or for decorations anchored to ranges that survive an
edit. ProseMirror goes underneath, with the IME gate as the acceptance test.

**Guided harness setup.** The agent panel can say a command is unreachable; it
cannot yet find the harnesses a machine already has.

**Persistence across restarts.** The agent roster now survives in
`.refrain/agents.json`, templates included — it was the one thing here the disk
could not rebuild. The queue and unmerged proposals still live in memory, and
should be rebuilt from `.refrain/runs/`, which is already on disk: the results
are there, so a reopened project ought to find its own unfinished work rather
than being told about it.

**The canvas layout.** A window per piece, arranged freely, zoomable to a full
editing surface. Designed, not built; the switch in settings is disabled and
marked so nobody mistakes it for working.

**Search across the workspace,** not just the open chapter.

## Later

**Retrieval over the ledger.** The verdicts accumulate whether or not anything
reads them; making them searchable is what turns a record into taste.

**More harness adapters at L2.** Each one is a contract test against a real
session, not a claim in a table.

**Selective undo at scale.** A compensating action against the first of 10,000
disjoint edits, without replaying the history.

**Lossless Markdown, not only the lower bound.** v0.1.5 guarantees that bytes
you did not edit come back unchanged. The stronger promise — that a paragraph
you *did* rewrite also round-trips through every Markdown construct — needs a
real document model, and belongs with the editor core rather than before it.

## Not planned

Multi-user collaboration. Cloud sync. A plugin loader. Any of these would
require the application to make network requests, keep accounts, or run code it
did not ship — and the value of the refusals in the README is that they are
unconditional.
