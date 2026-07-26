# RefRain

**A local writing workbench where every agent edit is a proposal you can refuse — and your refusal is data.**

*[中文 README](README.zh-CN.md)* · *[Download for Windows](https://github.com/kaile9/refrain/releases/latest)*

---

A *refrain* is the line a song returns to. To *refrain* is to hold back. And a *ref* is what you consult when you want to be sure. The name carries all three, because the work does: you return to the manuscript, you withhold assent until you have read the proposal, and the record of what you decided is there to consult later.

## Why you would use this

Start with what it refuses to do.

**It will not write into your manuscript.** Agents produce proposals. A human click merges one. There is no auto-accept, no background merge, no YOLO mode — and no setting, flag, or plugin that creates one. If you have ever run an agent over a chapter and then spent an hour finding what it quietly changed, this is the entire reason this project exists.

**It will not phone home.** The application process makes no outbound network requests. No account, no telemetry, no auto-update, no crash reporting. Every model call happens inside your own harness, under your own credentials. You can verify this with a firewall, which is why the claim is worth stating this way.

**It will not estimate your bill.** No prices, no cost projections, no "you have used 40% of your budget." Token counts are reported exactly as your harness reports them, tagged `actual`, `estimated`, or `unknown`. When a harness reports nothing, you see *unknown* rather than a plausible-looking zero.

**It will not spend tokens you did not authorize.** No background summarisation, no automatic context enrichment, no helpful pre-fetching. Every run appears in a manifest you approve before it is sent, and nothing is silently trimmed to save you money.

**It will not lock up your work.** Markdown files on disk, readable and git-trackable without this application. Delete the app tomorrow and your manuscript is intact.

**It will not stop working when the agents do.** With every harness disconnected, this is still a complete writing application: open, edit, search, save, undo.

What remains after those refusals is a workbench that shows you exactly what an agent proposes, lets you accept it, rewrite it, or throw it out with a reason — and keeps the reason.

## The ledger

Every judgment you make — accept, reject, accept-with-changes, and **why** — is stored, searchable, and replayable. Other tools treat a verdict as a UI event: you click accept and the reasoning evaporates. Keeping it produces three things nothing else offers.

**Reply.** Your verdict becomes part of the next prompt. The agent learns why the last draft was refused, in your words.

**Taste.** Accumulated verdicts are a sample of your judgment. No training required, only retrieval.

**Provenance.** A finished work can show which sentence you wrote, which an agent proposed, and which an agent proposed and you revised.

Editors go stale. Harnesses turn over yearly. The ledger does neither.

## One entrance

There is no permanent toolbar. **Ctrl K** reaches every command; panels open on demand and close on Escape. What stays on screen is the manuscript.

**Ctrl Enter** enters Zen: the text and its rest, with typewriter scrolling so the line you are writing stays near the middle of the screen rather than sinking to the bottom edge.

## Typography

Eighteen controls — face, size, weight, leading, tracking, word spacing, measure, first-line indent, paragraph spacing, alignment, margins, ruled lines, line numbers, and more. Chinese and Latin faces are set separately, values can be typed as well as dragged, and your own installed fonts are listed and searchable.

Five typefaces ship with the application under the SIL Open Font License, so it renders identically on every machine: **Chiron Sung HK** sets the Chinese, **Antic Didone** the display, **Jost** and **Murecho** the interface, **Courier Prime** the monospace.

The ruled lines land one pixel under the glyphs, per paragraph. That sounds like a detail until you see the alternative: a grid painted on the container drifts out of step wherever paragraph spacing is not a whole number of line boxes, and the rules end up through the middle of the characters. `scripts/verify-grid.ts` measures it on every build.

**Breathing** dims every paragraph but the one under your cursor. Not the blackout that focus modes use — in long-form work the surrounding text is what you are writing against.

## Agents

Any harness works. The floor is the **file channel**: the application writes `request.md`, you hand it to anything at all — a terminal agent, a web chat, a colleague — and paste the reply into `result.md`. No command, no configuration, no network.

Above that, a **command adapter** automates any harness with a command-line entry point, and the agent panel tells you whether it is actually reachable rather than storing a command and letting you discover the mistake an hour later.

| Harness | Tier | Entry point |
|---|---|---|
| Codex | L2 | `codex app-server --stdio` |
| Claude Code | L2 | Agent SDK `query()` |
| Pi | L2 | RPC over stdio |
| Kimi Code | L2 | node-sdk `KimiHarness` |
| Hermes | L1+ | TUI Gateway JSON-RPC |
| Anything else | L0 | the file channel |

## What changed, and putting it back

Every edit you make is recorded as an addressable change. Revert any one of them without disturbing the others, revert the lot, or attach your own note to a change and send the whole account to an agent so it works against the current text rather than the version it last saw.

## Install

Download the installer from [Releases](https://github.com/kaile9/refrain/releases/latest). Windows x64.

Then open a folder of Markdown files, or drop one onto the window. Several folders can be open at once, and a single file can be opened without adopting its neighbours.

## Build from source

```bash
bun install
bun run gate                    # format, typecheck, test
cd apps/desktop && ./make.sh    # renderer, main, preload
bun x electron dist/main/main.cjs
```

## Two origins

**[md2prompt](https://github.com/kaile9/md2prompt)** proved the half that mattered: that a human should see exactly what goes to a model and exactly what comes back. RefRain inverts the direction — the manuscript is the fixed point and the agent's output is the thing under review.

**[apostle-skills](https://github.com/kaile9/apostle-skills)** supplied the discipline. `apostle-artifacts-loops` gave the delegation rules: single-use identifiers, retries that never overwrite, disk artefacts as the meeting point between processes. `apostle-constitutio` gave the two-way zero trust — an agent's self-report is never taken as evidence of what it did.

## Licence

Not yet chosen. Bundled typefaces are under the SIL Open Font License; their licences travel with them in `apps/desktop/src/renderer/fonts/`.
