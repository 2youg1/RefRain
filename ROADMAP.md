# Roadmap

*[中文版](ROADMAP.zh-CN.md)*

---

## Now — v0.1

Windows first. One author, one local project, several local agents, chapterized Markdown.

The path the release must complete:

```
create project -> write normally -> select a range, write a prompt, pick an agent
-> queue it -> send the batch with one click
-> harness runs and writes a Result Artifact
-> app freezes Proposals and Review Slices -> human adjudicates
-> Decision Batch produces a new Text Head -> the verdict enters the ledger
```

**In v0.1**

- Transactional manuscript: Text Action, Text Change, Text Head, Revision, selective undo
- Source Backup and crash recovery
- Batched dispatch with a consolidated send manifest
- Result Artifact validation, Proposals, Review Slices, three-way conflict comparison
- Verdict Ledger: persistence and reply serialization
- Inline ghost diff and a standalone review window
- Competing proposals from several agents
- Five adapters — Codex, Claude Code, Pi, Kimi Code at L2; Hermes at L1+
- L0 file channel, so any harness works immediately
- A manuscript path that stays complete while every agent is offline

**Visual scope in v0.1**

One restrained typographic setting for Chinese and Latin text: size, leading, tracking, measure. Palettes and motion come after real long-form text renders — **taste grows from pixels, not from specifications**.

## Next

**v0.2 — platform and craft**
macOS build · review canvas for arranging competing proposals · minimap with pending-verdict density · branch comparison across one baseline · command palette and rebindable keys

**v0.3 — what the ledger is for**
Features that only become possible once verdicts accumulate: search by reason, agent, or chapter · replay a cluster of past verdicts into the next prompt so an agent learns what this author consistently rejects · provenance view showing which sentence a human wrote, which an agent proposed, which an agent proposed and a human revised

**v0.4 — orchestration**
Cross-session dialogue: two sessions each hold a character, the workbench relays between them for several rounds, and the resulting exchange arrives as one Proposal · batch fan-out via AgentSwarm (Kimi Code supports up to 128 subagents) · every round still advances on a human click; an Automation Grant requires a round ceiling and writes each round into a visible queue

**v0.5** — Linux build

## Plugins

**v1 defines the seams; it does not ship a loader.**

Two public interfaces are frozen so plugins can later attach to the same shape: `HarnessAdapter` (SPEC §6.2), and the Review Engine's Proposal and Slice interfaces.

Until a loader exists, extension means a fork or a pull request. That ordering is deliberate: **an interface proven by real use is safer to open than one designed for imagined plugins**.

## Harness compatibility

Five at launch (SPEC §6.3). The list grows through contributions.

| Tier | Effort | What it buys |
|---|---|---|
| L0 file | A few dozen lines | The harness works immediately |
| L1 session | About a day | Dispatch, cancel, status |
| L2 trusted | Depends on the harness | Real token figures, trustworthy context warnings |

Report the tier you reach; the README publishes it. **Missing capability is degradation with honest labeling, never rejection.**

## Deliberately not built

Each of these would turn a verifiable principle into a claim you have to take on trust.

- Model providers, API keys, accounts inside the app
- Telemetry, cloud sync, auto-update
- Multi-user real-time collaboration. If it ever ships, two rules survive: agents never write the manuscript directly, and a Proposal always cites an explicit Revision
- Remote agent execution
- A general workflow editor with draggable nodes
- Replacing Word as a typesetting destination — export is a bridge, not a home
- Code completion and general IDE features. This is a writing workbench

## Versioning

Protocols follow semver: a mismatched major is refused; a minor may add or remove fields and parsers tolerate unknown ones.

The Electron version stays pinned and revertible. Every bump runs the `e2e/ime` gate first — whether Chinese input works is a qualification, not a performance metric.
