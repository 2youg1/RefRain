# Stet

**A local writing workbench where every agent edit is a proposal you can refuse — and your refusal is data.**

*[中文](#中文)*

---

`stet` — Latin, *let it stand*. A proofreader's mark an author writes in the margin to overrule an editor's deletion and restore the original. It is the oldest recorded act of a writer exercising veto over someone else's improvement.

That act is the whole product.

## The problem

Agents write directly into your files. You get a diff, you skim it, you accept or you revert. Then the reasoning evaporates — why you rejected that paragraph, what was wrong with that phrasing, which version of the character's voice you actually wanted. Next session, the agent makes the same mistake, and you correct it again.

Every tool treats your judgment as a transient UI event. Click accept, and it's gone.

## The idea: a Verdict Ledger

Stet persists it. Every judgment — accept, reject, accept-with-changes, and **why** — is first-class, durable, structured data.

That single change produces three things:

**It replies.** Your verdict becomes part of the next prompt. The agent reads why the last draft failed, in your words, anchored to the exact passage.

**It accumulates.** A few hundred verdicts are a sample of how you actually judge prose. No training, no fine-tuning — just retrieval against your own recorded taste.

**It proves.** A finished manuscript can show which sentence you wrote, which an agent proposed, and which an agent proposed and you rewrote.

Editors go stale. Harnesses turn over every year. A record of your judgment does neither.

## How it works

```
write normally
  -> select a passage, write a prompt, pick an agent
  -> queue it; batch as many as you like
  -> send with one click
  -> your harness runs and writes a result file
  -> Stet freezes it into an immutable Proposal
  -> you adjudicate, slice by slice, with reasons
  -> your decision commits atomically to the manuscript
  -> the verdict enters the ledger
```

Stet contains no model, no API key, no account. It drives **your** harness — Codex, Claude Code, Pi, Kimi Code, Hermes — and reads what that harness writes to disk.

## Principles

These are constraints on the implementation, not marketing copy. Each one is verifiable.

**Zero network.** The app process makes no outbound requests. Every model call happens inside your own harness, under your own credentials. You can verify this with a firewall.

**Zero telemetry.** No accounts, no analytics, no auto-update, no phoning home.

**No autonomy over your text.** Agents never write the manuscript. They write proposals. Only a human click merges one. There is no YOLO mode, no auto-accept, no background merge — and no setting, flag, or plugin that creates one.

**No billing math.** Stet never shows you a price or a cost estimate. It reports token counts exactly as your harness reports them, tagged `actual`, `estimated`, or `unknown`. When a harness reports nothing, you see *unknown* — not a plausible-looking zero.

**Files are truth.** Markdown on disk. Readable, editable, and git-trackable without this application. If Stet disappears tomorrow, your work is intact.

**It works offline.** With every agent disconnected, Stet is still a complete writing application: open, edit, search, save, undo.

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

## Status

Early development. [`SPEC.md`](SPEC.md) is the authoritative design baseline; [`ROADMAP.md`](ROADMAP.md) covers scope and what is deliberately excluded; [`AGENTS.md`](AGENTS.md) is the working contract for contributors, human or otherwise.

Built with TypeScript, Bun, Electron, Svelte, and ProseMirror.

---

## 中文

**一个本地写作工作台：Agent 的每一次落笔都是你可以否决的提案，而你的否决本身是数据。**

`stet` 是校对符号，拉丁语「让它保留」。作者在页边写下它，推翻编辑的删改、恢复原文——这是有记录以来最古老的一个动作：写作者对他人的「改进」行使否决权。

这个动作就是产品的全部。

### 问题

Agent 直接写进你的文件。你看一眼 diff，接受或还原。然后理由就蒸发了——你为什么否掉那一段、那句话哪里不对、这个人物的语气你到底要哪一版。下一次它再犯同样的错，你再改一遍。

所有工具都把你的判断当成一次性界面事件。点了接受，事就没了。

### 核心：裁决账本

Stet 把它留下。每一次判断——接受、拒绝、改后接受，以及**为什么**——都是一等公民数据。

这一个改动带来三件事：

**它会回话。** 你的裁决成为下一轮 Prompt 的一部分。Agent 用你自己的话、锚在具体段落上，读到上一版为什么不行。

**它会累积。** 几百条裁决就是你判断文字的样本。不训练、不微调，只是检索你自己记录下来的口味。

**它能作证。** 一部完成的稿子可以显示：哪一句是你写的，哪一句是 Agent 提议的，哪一句是 Agent 提议而你重写的。

编辑器会过时，Harness 每年换一批。你的判断记录不会。

### 原则

以下是对实现的约束，不是宣传语。每一条都可验证。

**零联网。** 应用进程无出站请求。所有模型调用发生在你自己的 Harness 里，用你自己的凭据。你可以用防火墙验证这一点。

**零遥测。** 无账号、无统计、无自动更新。

**不对你的文字自作主张。** Agent 从不写正文，只写提案。只有人点击才合并。没有 YOLO、没有自动接受、没有后台合并，也没有任何设置或插件能造出一个。

**不替你算钱。** 从不显示价格或成本估算。token 数如实回传 Harness 上报值，标注 `actual`、`estimated` 或 `unknown`。Harness 报不出来，你看到的就是「未知」，而不是一个看起来很合理的零。

**文件即真相。** Markdown 落盘，离开这个应用依然可读、可改、可 git。Stet 明天消失，你的稿子完好无损。

**离线可用。** 所有 Agent 断开时，Stet 仍是一个完整的写作软件：打开、编辑、搜索、保存、撤销。

### 现状

早期开发中。[`SPEC.md`](SPEC.md) 是唯一权威设计基准，[`ROADMAP.md`](ROADMAP.md) 说明范围与明确不做的事，[`AGENTS.md`](AGENTS.md) 是贡献者（人或 Agent）的工作契约。
