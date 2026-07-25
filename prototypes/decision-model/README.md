# Prototype — decision model

**Throwaway.** Answers one question, then gets absorbed into `packages/core`.

## The question

SPEC §7.4 defines how a Decision Batch compiles staged verdicts into a single Text Action: rebuild each proposal from accepted slices, map from each proposal's own baseline onto one `commit_basis`, verify before-text, require pairwise disjointness, refuse the whole batch on conflict.

Every one of those rules reads fine on paper. The question was whether the model **behaves correctly when pushed through real cases** — competing agents on one paragraph, a human rewriting an agent's sentence, the manuscript drifting while proposals sit queued.

## Run it

```bash
bun prototypes/decision-model/drive.ts   # 10 scenarios, non-interactive
bun prototypes/decision-model/tui.ts     # drive it by hand (needs a TTY)
```

## Verdict: the model holds

21 assertions across 10 scenarios, all passing. Three findings worth recording:

**Competing proposals refuse cleanly.** Staging two agents' proposals on the same scope aborts the batch and names the overlap (`s-b2 and s-b2 both touch b2`) rather than picking a winner by list order. This is SPEC §7.4 rule 4 working as intended — and it is the behaviour that would have been easiest to get subtly wrong.

**The audit chain survives `accept-modified`.** After a human rewrites an agent's sentence, the manuscript carries the human's wording while the Proposal still holds the agent's original. Both are readable afterward, which is what makes provenance claims in the README true rather than aspirational.

**Drift is caught at commit, not at dispatch.** When the manuscript changes under a queued proposal, `mapOnto` fails on before-text comparison and the batch is refused. No forced application, no silent three-way merge.

## What lifts into `core`

`model.ts` is pure — no I/O, no terminal, no console. It moves into `packages/core` mostly intact:

| Prototype | Destination |
|---|---|
| `sliceProposal` | Review Engine — replace the sentence splitter with a real one |
| `rebuild` | Review Engine — unchanged |
| `mapOnto`, `commitBatch` | Review Engine — add persistence and Revision Store calls |
| `applyChanges`, `serialize` | Text engine — replace with the real block model |
| `commutes` | Test helper, not production code |

`tui.ts` and `drive.ts` do not lift. `drive.ts`'s ten scenarios become `packages/core` test cases.

## Known gaps

Deliberate, because they do not affect the question:

- Sentence splitting is a regex. Real text needs the `md2prompt` sentence heuristics.
- Blocks are flat with no chapters, no line numbers, no anchors.
- No selective undo, no persistence, no Result Artifact parsing.
- Overlap detection compares block IDs. Real Edit Scopes need character-range comparison.
