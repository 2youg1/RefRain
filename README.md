# RefRain

A local writing workbench where every agent edit is a reviewable proposal, and the manuscript stays in human hands.

[简体中文](README.zh-CN.md) · GPL-3.0-only

---

## What it is

Write in Markdown. Send a passage to whichever coding agent you already run — Claude Code, Codex, Pi, Kimi, or your own script. What comes back is **a proposal, not an edit**: you read it sentence by sentence, take what earns its place, reject the rest, and say why. Your reasons are saved, replayable, and sent back with the next request.

Three axioms, in priority order:

1. **Files are truth.** Markdown on disk, editable and git-trackable without this application ever running.
2. **Proposals are data.** An agent's edit is a reviewable object, not an accomplished fact.
3. **Verdicts are replies.** Accept, reject, revise, annotate — all serialized back to the agent.

## Why RefRain

- **The author decides.** Agent output cannot touch the manuscript. It becomes an immutable Proposal; only a Text Action approved by a human changes the file.
- **Local and private outrank convenience.** The application has no account, API key, telemetry, updater, or outbound request. Manuscripts and collaboration history stay in the project folder.
- **Your bytes survive.** Open a file, save it, and the bytes you did not edit are the bytes you had — the ideographic indent that opens a Chinese paragraph, the blank line inside a fenced block, the ones you left between paragraphs. A gate over twenty corpora fails the build if that stops being true.
- **Typing Chinese waits for the input method.** A save requested mid-composition happens when the word is finished, not while it is still pinyin.
- **Performance is measured on the interaction path.** Rust keeps large file indexes out of the renderer, the list only mounts visible rows, and saving a 100,000-block manuscript costs what the change costs rather than what the book costs.
- **Nothing is trapped.** The manuscript is plain Markdown. Agent rosters, requests, results, and memos use documented files that remain readable and editable without RefRain.
- **Regret has several honest forms.** Reject a Slice before merge, undo ordinary typing, selectively compensate an older Text Action without replaying later history, or inspect both versions when another editor changed the file.
- **Several agents may disagree on one baseline.** Broadcast one request, keep every answer as a separate Proposal, compare competitors, and merge only the one whose wording survives review.
- **Harnesses are replaceable.** L0 accepts any program that can read and write a file; L1 launches argv without a shell; the L2 contract adds verifiable sessions and usage without changing the review model.

## The Verdict Ledger

Every judgment about agent output — accept, reject, accept-with-changes, and **why** — is first-class data: persisted, searchable, accumulating.

Existing tools treat a verdict as a transient UI event. Click accept, and the reasoning evaporates. Persisting it produces three things nothing else offers:

- **Reply.** The verdict becomes part of the next prompt. The agent learns why the last draft was rejected.
- **Taste.** Accumulated verdicts are a sample of this author's judgment — no training required, only retrieval.
- **Audit.** A finished work can show which sentence a human wrote, which an agent proposed, and which an agent proposed and a human revised.

Editors go stale. Harnesses turn over yearly. The ledger does neither.

## What it will not do

Building any of these is a defect, not a missing feature:

- **No network.** The application process makes no outbound requests. No API keys, no accounts, no telemetry, no auto-update. Every model call happens inside your own harness.
- **No auto-merge.** No YOLO mode, no auto-accept, no background merge, no agent self-adjudication. No setting, flag, or plugin bypasses a human click.
- **No billing math.** No prices, no cost estimates. Token counts are reported exactly as the harness reports them, tagged `actual` / `estimated` / `unknown`. When the harness says nothing, the interface says unknown.
- **No permanent delete.** Deletion goes to the system trash — `IFileOperation` on Windows, `NSFileManager` on macOS, freedesktop.org on Linux. There is no permanent variant at any layer, and CI fails if one appears.

## Speed

The file layer is a Rust crate (`packages/fs`) reached through N-API. It exists because four operations sit on the interaction path and JavaScript cannot make them fast enough.

Measured on a 20,000-file tree, warm cache, p50 over ten runs:

| Operation | p50 | p95 |
|---|---:|---:|
| Scan 20,000 files | 10.38 ms | 11.33 ms |
| Sort by name, natural order | 0.80 ms | 0.94 ms |
| Substring search | 6.66 ms | 8.22 ms |
| Subsequence search | 7.71 ms | 10.24 ms |
| CJK search | 5.88 ms | 6.99 ms |
| Page 200 rows | 0.13 ms | 0.17 ms |

Every interactive operation fits inside a 120 Hz frame budget of 8.3 ms. The index stays in Rust; the renderer receives only the rows it can display, so a 20,000-entry workspace puts about forty rows in the DOM.

Numbers sort as a reader reads them — `chapter-10` follows `chapter-9`. Search offsets are character offsets, so a Chinese filename highlights the glyph you typed rather than a byte in the middle of it.

## The display

Two facts about your monitor change how the application draws, and neither is knowable at build time.

**Refresh rate.** Durations are expressed in frames of the measured rate. Eight frames is 133 ms at 60 Hz and 48 ms at 165 Hz — the same gesture on either panel, rather than motion quantised to whichever display the developer owned. Dragging a window between monitors retargets it.

**Pixel density.** A hairline is one device pixel, not one CSS pixel. At 300% scaling a 1px border is a blurry three-pixel smear, and this application's ruled baseline grid is made of hairlines.

## Getting started

```bash
bun install
bun run native     # builds the Rust file layer for this platform
bun run dev
```

`bun run native` needs a Rust toolchain and a system C compiler. On a machine without `cc`, `source scripts/native-env.sh` first — it points cargo at Zig, which ships a complete C toolchain in one archive.

A project is a plain folder of Markdown files. Open one, and `Ctrl K` brings up every command.

## Harness support

Adapters are tiered by what the harness can prove, not by preference:

| Tier | What it means |
|---|---|
| **L0** | File channel. The agent reads `request.md` and writes `result.md`. Works with anything that can read and write a file. |
| **L1** | Command. RefRain launches your harness and collects the result. |
| **L2** | Session. The harness reports its model, effort, and token usage, and RefRain relays them verbatim. |

L0 and L1 ship today. The Claude Code adapter also parses the CLI's model and token report, but remains labeled L1 until a real installed session and compaction signal pass the §6.5 contract. A harness at any tier is a harness that works — the tier says how much RefRain can prove, not whether it runs.

## Building

```bash
bun run gate       # fmt:check → check → test, all three green or it does not land
bun run native     # the platform binary
cd apps/desktop && ./make.sh && bun x electron-builder --win --x64
```

The `gate` workflow builds and tests the native layer on every platform covered by ordinary CI. Current 0.1.x tags run `release.yml` on Windows x64 and publish one NSIS installer after the real window launch check passes.

## Verification

Green assertions are not correctness. Beyond the unit tests:

- `bun run verify:no-network` — no outbound request reaches the application process
- `bun run verify:trash-only` — no permanent delete exists at any layer
- `bun run verify:roundtrip` — twenty corpora load and save byte for byte, block count included
- `bun run verify:scale` — six mutation shapes up to 100,000 blocks stay inside their budget
- `bun run verify:gate` — the type gate is provably capable of failing
- `apps/desktop/scripts/verify-composition.ts` — no save lands mid-composition, and an indent renders as an indent
- `apps/desktop/scripts/verify-files.ts` — the file browser is measured as rendered: a windowed list, columns whose headers sit over their own values, a hairline that is one device pixel
- `apps/desktop/scripts/verify-grid.ts` — ruled lines land under the glyphs, not through them
- `e2e/ime` — Windows + Microsoft Pinyin, four shells, real `SendInput` typing. Required before any Electron upgrade.

## Documentation

| Document | What it holds |
|---|---|
| [`SPEC.md`](SPEC.md) | The authoritative design baseline. When the code disagrees, the code changes. |
| [`AGENTS.md`](AGENTS.md) | How to work in this repository: invariants, style, gates. |
| [`ROADMAP.md`](ROADMAP.md) | What shipped, what is known broken, and what comes next. |
| [`docs/TEST-MATRIX.md`](docs/TEST-MATRIX.md) | Every test that exists and every one that should. |
| [`docs/project-layout.md`](docs/project-layout.md) | The portable project folder, ownership, and write permissions. |
| [`docs/flow.md`](docs/flow.md) | The complete dispatch, review, decision, merge, and reply path. |

## Licence

GPL-3.0-only. A writing tool that reads your manuscript should be one you can read back.

> “有些前沿AI实验室做出了出色的Code应用，却没有任何一家实验室做出了优秀的Work，你猜为什么呢？So FUCK all XX-Work，用RefRain搭配优秀的Code享受前沿模型带来的便利与开源社区的智慧”
>
> — 2youg1
