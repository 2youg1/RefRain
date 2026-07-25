# Recension

**A local writing workbench where every agent edit is a proposal you can refuse — and your refusal is data.**

*[中文 README](README.zh-CN.md)*

---

*Recension* — the scholarly practice of collating variant manuscripts and deciding, with stated reasons, which reading stands. Competing versions arrive; one human judges; the judgment is recorded and can be argued with later.

That is the whole product.

## Why you would use this

Start with what it refuses to do.

**It will not write into your manuscript.** Agents produce proposals. A human click merges one. There is no auto-accept, no background merge, no YOLO mode — and no setting, flag, or plugin that creates one. If you have ever run an agent over a chapter and then spent an hour finding what it quietly changed, this is the entire reason this project exists.

**It will not phone home.** The application process makes no outbound network requests. No account, no telemetry, no auto-update, no crash reporting. Every model call happens inside your own harness, under your own credentials. You can verify this claim with a firewall — which is the point of stating it this way.

**It will not estimate your bill.** No prices, no cost projections, no "you have used 40% of your budget." Token counts are reported exactly as your harness reports them, tagged `actual`, `estimated`, or `unknown`. When a harness reports nothing, you see *unknown* rather than a plausible-looking zero.

**It will not spend tokens you did not authorize.** No background summarization, no automatic context enrichment, no helpful pre-fetching. Every run appears in a manifest you approve before it is sent, and nothing is silently trimmed to save you money.

**It will not lock up your work.** Markdown files on disk, readable and git-trackable without this application. Delete the app tomorrow and your manuscript is intact and unchanged.

**It will not stop working when the agents do.** With every harness disconnected, this is still a complete writing application: open, edit, search, save, undo.

What remains after those refusals is a workbench that shows you exactly what an agent proposes, lets you accept it, rewrite it, or throw it out with a reason — and remembers the reason.

## The idea: a Verdict Ledger

Agents write directly into your files. You get a diff, you skim it, you accept or revert. Then the reasoning evaporates — why you rejected that paragraph, what was wrong with that phrasing, which version of the character's voice you actually wanted. Next session, the agent makes the same mistake, and you correct it again.

Every tool treats your judgment as a transient UI event. Click accept, and it is gone.

Recension persists it. Every judgment — accept, reject, accept-with-changes, and **why** — is first-class, durable, structured data. That single change produces three things:

**It replies.** Your verdict becomes part of the next prompt. The agent reads why the last draft failed, in your words, anchored to the exact passage.

**It accumulates.** A few hundred verdicts are a sample of how you actually judge prose. No training, no fine-tuning — just retrieval against your own recorded taste.

**It proves.** A finished manuscript can show which sentence you wrote, which an agent proposed, and which an agent proposed and you rewrote.

Editors go stale. Harnesses turn over every year. A record of your judgment does neither.

## Not a harness — an orchestration layer above them

Recension runs no model and owns no agent loop. It drives the harnesses you already use, and its ambition sits one level up: **the coordination between a human and several agents, and among the agents themselves.**

Most harnesses give you one conversation and one agent. Real work is not shaped that way. Recension models it as a graph — tasks that fan out to competing agents, results that converge on a single human decision point, and a decision that becomes the input to the next round.

- **Competing proposals.** Broadcast one passage to several agents, then choose, combine, or reject all of them.
- **Cross-session dialogue.** Two sessions each hold a character; the workbench relays between them for several rounds; the resulting exchange arrives as one proposal.
- **Batched dispatch.** Queue work across chapters and agents, review the consolidated manifest, send once.
- **Every edge is human-gated.** No round advances without a click. No autonomous loop reaches your manuscript.

The first release targets long-form prose. The orchestration model is not specific to prose, and programming workflows follow.

## How it works

```
write normally
  -> select a passage, write a prompt, pick an agent
  -> queue it; batch as many as you like
  -> send with one click
  -> your harness runs and writes a result file
  -> Recension freezes it into an immutable Proposal
  -> you adjudicate, slice by slice, with reasons
  -> your decision commits atomically to the manuscript
  -> the verdict enters the ledger
```

## Harness support

Adapters are graded by what a harness can actually prove, not by what it claims.

| Tier | Requires | You get |
|---|---|---|
| **L0** | Nothing — the agent writes a file | Works with any harness, including copy-paste |
| **L1** | Programmatic sessions, completion events, cancellation | Dispatch, cancel, live status |
| **L2** | Honest usage reporting, effective-model readback, compaction events | Real token counts, trustworthy context warnings |

| Harness | Tier |
|---|---|
| [Codex](https://github.com/openai/codex) | L2 |
| [Claude Code](https://code.claude.com/docs) | L2 |
| [Pi](https://pi.dev) | L2 |
| [Kimi Code](https://moonshotai.github.io/kimi-code/) | L2 |
| [Hermes](https://hermes-agent.nousresearch.com/docs) | L1+ |

Missing capability is never rejection — it is degradation with honest labeling. An L0 adapter takes a few dozen lines. **Contributions welcome; the list is meant to grow.**

## Where this came from

Two earlier projects by the same author, both still running:

**[md2prompt](https://github.com/kaile9/md2prompt)** — a single-file HTML editor that logs every human revision and exports a protocol-precise `Prompt.md` for an agent to read. It proved the half that mattered: a human's edits and annotations, serialized into a format an agent consumes without tool calls or re-uploading the document. Recension inverts the direction — the agent proposes, the human adjudicates — and keeps the protocol discipline that made the original work.

**[apostle-skills](https://github.com/kaile9/apostle-skills)** — agent skills for serious reading, research, translation, and long-horizon work. Two shaped this design directly. `apostle-artifacts-loops` contributed the commissioning discipline: single-use identifiers, no overwrite on retry, and artifacts on disk as the meeting point between agents that cannot see each other. `apostle-constitutio` contributed bidirectional zero-trust, which became the rule that this workbench never believes an agent's own report — only files on disk, verified.

## Status

Early development. [`SPEC.md`](SPEC.md) is the authoritative design baseline; [`ROADMAP.md`](ROADMAP.md) covers scope and what is deliberately excluded; [`AGENTS.md`](AGENTS.md) is the working contract for contributors, human or otherwise.

Built with TypeScript, Bun, Electron, Svelte, and ProseMirror.
