# Roadmap

*[中文版](ROADMAP.zh-CN.md)*

---

## Shipped — v0.1.2

Windows x64. One author, several local folders, any harness, chapterised Markdown.

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
set separately; five bundled OFL typefaces; three themes; rebindable keys;
ruled lines that land under the glyphs; line numbers, a minimap, and a progress
gradient; an agent panel that reports whether a harness is actually reachable.

## Next — v0.2

**The canvas layout.** A window per piece, arranged freely, zoomable to a full
editing surface. Designed, not built; the switch in settings is disabled and
marked so nobody mistakes it for working.

**A real editor core.** The manuscript is currently a `contenteditable` with
paragraph elements. That is enough for prose and not enough for selective undo
across 10,000 actions, or for decorations anchored to ranges that survive an
edit. ProseMirror goes underneath, with the IME gate as the acceptance test.

**Search.** Across the workspace, not just the open chapter.

**The header alignment defect.** The chapter header will not share the
manuscript's left edge; cause unknown. Tracked in SPEC §12 Q5 and measured on
every capture run.

## Later

**Retrieval over the ledger.** The verdicts accumulate whether or not anything
reads them; making them searchable is what turns a record into taste.

**More harness adapters at L2.** Each one is a contract test against a real
session, not a claim in a table.

**Selective undo at scale.** A compensating action against the first of 10,000
disjoint edits, without replaying the history.

## Not planned

Multi-user collaboration. Cloud sync. A plugin loader. Any of these would
require the application to make network requests, keep accounts, or run code it
did not ship — and the value of the refusals in the README is that they are
unconditional.
