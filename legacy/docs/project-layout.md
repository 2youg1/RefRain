# 项目文件夹结构

一个 RefRain 项目就是一个普通文件夹。**所有 Agent 都以它为工作区**。

设计约束:软件不在的时候,这个文件夹仍然是一堆可读可编辑的文本;正文永远在最外层,状态藏进 `.refrain/`。

---

## 结构

```
我的长篇/                       ← 项目根，也是每个 Agent 的工作区
│
├── 第一章.md                   ← 正文。就是普通 Markdown，无前置元数据
├── 第二章.md                      任何编辑器都能开，软件不在也能写
├── 第三章.md
│
├── 资料/                       ← 你自己建的任何目录，软件不管
│   └── 年表.md                    Agent 可读（Context Scope 授权后）
│
├── .refrain-source/            ← Source Backup：原件，任何一层都不写入
│   └── 第一章.md                 （守卫已就位，创建时机待定）
│
└── .refrain/                   ← 软件状态。可整个删除，正文不受影响
    │
    ├── verdicts.db             ← Verdict Ledger：每次裁决＋理由（SQLite/WAL）
    │
    ├── memos/                  ← Agent 工作记忆。Markdown，你可以直接改
    │   ├── 文字编辑.md            按 Agent 分文件，追加不重写
    │   └── 结构读者.md
    │
    ├── agents.json             ← Agent 名册：身份、Runtime Binding、命令模板
    │                             人可直接编辑；损坏则读作空册，不阻止开项目
    │
    └── runs/                   ← 每个 Run 一个目录，软件从不自动删
        ├── run1/
        │   ├── request.md      ← 软件写：Before + Request + 回复契约
        │   └── result.md       ← Agent 写：只填 Agent reply 一节
        └── run2/
            ├── request.md
            └── result.md
```

---

## 各处的归属与可写性

| 路径 | 谁写 | 谁读 | 说明 |
|---|---|---|---|
| `*.md`(根下) | **只有人** | 人、Agent | 正文。Agent 永远只读 |
| `.refrain-source/` | 尚未由软件创建 | 人 | 原件。**任何情况下不写入**；守卫已就位（`guard.rs` 的 `SOURCE_BACKUP_DIR`），创建时机待定 |
| `.refrain/runs/<id>/request.md` | 软件 | Agent | 前两节由软件生成,所以来源可核验 |
| `.refrain/runs/<id>/result.md` | **Agent** | 软件 | Agent 唯一的写入口 |
| `.refrain/memos/*.md` | Agent 追加 | 人、后继 Agent | 人可编辑、可删除 |
| `.refrain/verdicts.db` | 软件 | 人 | 裁决审计,可检索 |

**一条铁律**:Agent 能写的只有 `.refrain/runs/<自己的 run>/result.md`。正文的任何变化都必经人点击。

---

## Agent 在一次 Run 里看到什么

`request.md` 是自足的——Agent 不需要读源码、不需要读文档,就能正确回复:

```markdown
# Before

<!-- scope s1 -->
雾从下游漫上来，把两岸的芦苇一层层收走。

# Request

把第二段改短。

# Reply format

Reply with one <agent-result> element and nothing else — no preamble,
no closing remark, no code fence. Text outside the element is rejected
and the run fails.

<agent-result version="1">
  <replacement scope="SCOPE-ID">the rewritten text</replacement>
  <comments>
    <comment target="SCOPE-ID">an observation that changes nothing</comment>
  </comments>
  <memo topic="optional label">what you want to still know next time</memo>
</agent-result>

Rules:
- Use the scope ids marked in "# Before" above, exactly as written.
- One <replacement> per scope at most. Repeating a scope fails the run.
- An empty <replacement> deletes that scope's text.
- Every <comment> goes inside <comments>, and uses target= rather than scope=.
- You are writing a proposal, not the manuscript. A human reads every
  change and decides.

About <memo>: write it for whoever works on this next — possibly you
after a compaction, possibly a different agent. …

# Agent reply

<!-- Your <agent-result> element replaces this comment. -->
```

**为什么契约要随请求走而不是放在仓库里**:Agent 没读过这个仓库。实测六种它可能写出的回复,五种失败——裸正文、代码块包裹、礼貌前言、漏 version、猜错元素名。前三种是多数 harness 的默认习惯。每失败一次就是一整轮 token 白烧,而且它不知道错在哪。

---

## Memo:Agent 自己写的记忆

这一项取代了此前设想的"口味画像"。**画像做不出来**——从一堆零散裁决归纳出"这个作者要什么"是归纳,而本软件不联网、不接 API、不跑模型,没有这个能力。

而 memo 有真实来源:**它由当时握有完整上下文的那一方写下**,也就是 Agent 自己,在它还记得的那一刻。

`.refrain/memos/文字编辑.md` 长这样:

```markdown
# 文字编辑 的工作记忆

## 2026-07-26T14:20:00.000Z · 语气

<!-- run run3 -->

作者不接受形容词堆叠。第三章的时间线已经定稿，不要再动。
他偏好短句收尾，但对话里可以长。

## 2026-07-26T16:05:00.000Z

<!-- run run7 -->

「雾」这个意象他改过三次都改回来了，是有意的，别再提。
```

三条性质:

- **追加,不重写**。Agent 无法抹掉它从前的判断——那份记录正是你看出标准漂移的依据。
- **人可编辑**。Markdown 而非数据库,软件不运行时你也能改。Agent 说自己做了什么,是主张而非证据,笔在你手上。
- **跨越断点**。Session 被克隆、被压缩、被换掉,原生上下文就没了;后继者拿起 memo 接着做。`carryForward()` 按字符预算从尾部取,新的优先。

---

## 与 AAL 的关系

这个设计来自 `apostle-artifacts-loops` 的一条:**以磁盘工件作为进程之间的会合点**。

RefRain 里的对应关系:

| AAL | RefRain |
|---|---|
| 一次性标识符 | `runs/run7/`,永不复用 |
| 重试不覆盖 | 每次重试是新 Run 新目录 |
| 磁盘工件作会合点 | `request.md` / `result.md` |
| 自报不作证据 | memo 由人过目才被复用 |

---

## 一个项目可以整个搬走

`.refrain/` 里没有绝对路径、没有机器标识、没有账号。整个文件夹拷到另一台机器,Agent 名册、裁决账本、工作记忆全部还在。

删掉 `.refrain/` 也不损失正文——你会失去协作历史,但稿子完好。
