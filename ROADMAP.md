# Roadmap

*[中文版](ROADMAP.zh-CN.md)*

---

## Shipped — v0.1.3

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

**A diff that scales.** The current LCS allocates an n×m matrix, which a
100,000-block manuscript cannot afford. Hirschberg or Myers.

## Not planned

Multi-user collaboration. Cloud sync. A plugin loader. Any of these would
require the application to make network requests, keep accounts, or run code it
did not ship — and the value of the refusals in the README is that they are
unconditional.
