# 修改全流程

一次完整往返：作者选段 → 派发 → Agent 回稿 → 逐条裁决 → 合并 → 下一轮。

设计约束贯穿全程：**只有人点击才改正文**、**不替用户算钱**、**未知即显示未知**。

---

## 全流程

```mermaid
flowchart TB
    subgraph KEY[" 图例 "]
        direction LR
        K1["人必须在场"]:::human
        K2["机器自动"]:::machine
        K3[("落盘")]:::store
        K4{"判定"}:::gate
    end

    W1["正文编辑<br/>Agent 离线也完整可用"]
    W2["editsBetween()<br/>块级 LCS 对齐"]
    W3[("Changelog<br/>base/cur 两快照")]

    D1["① 选 Edit Scope<br/>可多段不相交"]
    D2["② 写 Prompt"]
    D3{"Carry 开关<br/>默认 diff"}
    D4["diff：带 Changelog"]
    D5["full：带全文"]
    D6["none：都不带"]

    S1["③ 送审清单<br/>Run 数 · 锁定的 harness 与模型<br/>Edit Scope 范围 · Prompt 原文"]
    S2["各段字符数<br/>不折算 token<br/>不显示价格"]
    S3["drifted 标记<br/>排队期间原文变了，标记而不取消"]

    R1["composeRound()<br/>口味画像→全文→裁决→Changelog→请求"]
    R2["Adapter.dispatch()<br/>L0 文件 · L1 命令 · L2 原生"]
    R3["Agent 只写 Task Workspace<br/>正文只读"]

    C1["parseAgentResult()<br/>校验失败则 run=failed"]
    C2["每个 Edit Scope<br/>冻结一个不可变 Proposal"]
    C3["sliceProposal()<br/>确定性 diff 得 Review Slice"]
    C4{"classifyProposal()"}

    V1["④a 格式类一次全过<br/>Alt+Shift+A"]
    V2["④b 语义类逐条读<br/>Alt+J / Alt+K 移动"]
    V3["Alt+A 接受<br/>Alt+X 拒绝<br/>Alt+E 改后合并"]
    V4["⑤ Alt+S 打勾攒批<br/>未勾的留下精调"]

    M1["⑥ commitDecisionBatch()<br/>Alt+Enter 一次提交"]
    M2{"基线还成立"}
    M3["整批拒绝<br/>指名冲突处，不暗选赢家"]
    M4["⑦ 一个 Text Action<br/>新 Text Head，定为 Revision"]

    L[("Verdict Ledger<br/>裁决与理由落盘")]

    W1 --> W2 --> W3 --> D1 --> D2 --> D3
    D3 -->|diff| D4
    D3 -->|full| D5
    D3 -->|none| D6
    D4 & D5 & D6 --> S1 --> S2 --> S3
    S3 -->|人点击发送| R1 --> R2 --> R3
    R3 -->|写 result.md| C1 --> C2 --> C3 --> C4
    C4 -->|formatting| V1
    C4 -->|semantic| V2 --> V3
    V1 & V3 --> V4 --> M1 --> M2
    M2 -->|否| M3
    M3 -->|回到逐条复核| V2
    M2 -->|是| M4
    M4 --> L
    M4 -->|正文已变，下一轮| W1
    L -.->|"作者查阅后自行修订 persona"| R1

    classDef human fill:#f7e9e4,stroke:#a8422f,stroke-width:2.5px,color:#22201d
    classDef machine fill:#f0ece5,stroke:#a8a49b,color:#22201d
    classDef store fill:#e4ebe6,stroke:#5c7a5e,stroke-width:2px,color:#22201d
    classDef gate fill:#f0ece5,stroke:#7d8471,stroke-dasharray:4 3,color:#22201d
    class D1,D2,V1,V2,V3,V4,M1 human
    class W1,W2,R1,R2,R3,C1,C2,C3,D4,D5,D6,S1,S2,S3,M3,M4 machine
    class W3,L store
    class D3,C4,M2 gate
```

朱色框是**人必须在场**的环节，灰框是机器可自动完成的，绿框是落盘的持久物。
注意朱色框从不出现在 ⑤ 之后到 ⑥ 之前——那一段是机器的活；也从不缺席 ⑥ 与 ⑦。

---

## 一次往返里 Prompt 长什么样

顺序即缓存策略。稳定的在前，每轮变的在后。

```
<persona>                  ← 作者手写的身份，跨会话不变
  你是文字编辑。删掉不承载信息的修饰，
  保留作者的句读习惯。
</persona>

<manuscript>…</manuscript>   ← 仅 carry=full 时出现

<changes>                   ← 上一轮的裁决
  <verdict n="1" ref="s1" kind="reject">
    <reason>偏离语气</reason>
  </verdict>
</changes>

<edits>                     ← 仅 carry=diff；作者手改的部分
  <edit n="1" kind="replace">
    <before><![CDATA[…]]></before>
    <after><![CDATA[…]]></after>
    <note>补一个动作</note>
  </edit>
</edits>

<request>把第二段改得更短。</request>
```

**为什么 Changelog 放最后**：harness 按字节匹配前缀命中缓存。放在末尾，前面的口味画像与全文原样命中；插在开头，则每一轮都要按全价重读它后面的每一个 token。测试 `round-input.test.ts` 里那条「新 Changelog 不改动它之前的前缀」就是守这个性质的。

---

## Agent 回稿的格式

应用生成前两节，Agent 只填第三节——所以来源可核验，而非仅凭声称。

```markdown
# Before
<!-- scope b7 -->
（基线 Revision 处的原文）

# Request
（作者的 Prompt）

# Agent reply
<agent-result version="1">
  <replacement scope="b7">改写后的文字</replacement>
  <replacement scope="b19">另一段的改写</replacement>
  <comments>
    <comment target="b7">这里我拿不准，原文的「停」可能是有意的。</comment>
  </comments>
</agent-result>
```

一个 Run 一次提交，多个 Edit Scope 一次回来。校验失败则 `run=failed`，**不产生任何 Proposal**——提案只从已校验的工件冻结。

---

## 三档 Carry 怎么选

| 档 | 传什么 | 适合 | 代价 |
|---|---|---|---|
| **diff**（默认） | 口味画像＋裁决＋Changelog | 长期协作，Agent 已持有正文 | 增量最小，缓存命中最好 |
| **full** | 口味画像＋全文＋裁决 | 新建 Agent、刚压缩过、换 harness | 每轮重付全文 |
| **none** | 只有口味画像＋裁决 | 单 Agent 负责单段落 | Agent 不知道别处发生了什么 |

---

## 裁决路径

```mermaid
flowchart LR
    P["Proposal"] --> K{"classifyProposal()"}
    K -->|"formatting<br/>骨架相同"| F["Alt+Shift+A<br/>一次全过"]
    K -->|"semantic<br/>骨架有变"| S["逐条阅读"]
    S --> A["Alt+A 原样接受"]
    S --> X["Alt+X 拒绝"]
    S --> E["Alt+E 改后合并<br/>写入 finalText"]
    F & A & E --> B["Alt+S 打勾入批"]
    X --> L[("只落 Verdict<br/>不动正文")]
    B --> C["Alt+Enter 提交"]

    classDef human fill:#f5e6e0,stroke:#a8422f,stroke-width:2px
    class F,S,A,X,E,B,C human
```

**分类的安全性质**：骨架比较只允许标点与空白变动，汉字、假名、拉丁字母、数字一律计入语义。「他停笔，雾散了」↔「雾散了，他停笔」每个字都在，仍判为语义——纯字符集比较会漏掉它。

漏判一个格式修正，作者多按一次键；错判一个语义修改，作者的稿子里出现他没同意过的句子。所以分类器宁可保守。

---

## 快捷键

Windows 已经占用的位，语义一致就直接复用，不另造：

| 复用 | 命令 | 理由 |
|---|---|---|
| `Ctrl+S` `Ctrl+O` `Ctrl+N` `Ctrl+F` `Ctrl+Z` `Ctrl+Y` | 保存／打开／新建／查找／撤销／重做 | 语义与系统一致 |

裁决动作一律 `Alt+`，因为检阅时正文有焦点、常有输入法候选窗开着——**裸字母键在中文写作里是字符，不是命令**：

| 键 | 动作 |
|---|---|
| `Alt+J` / `Alt+K` | 下一条／上一条 |
| `Alt+A` / `Alt+X` / `Alt+E` | 接受／拒绝／改后合并 |
| `Alt+S` | 打勾入批 |
| `Alt+Shift+A` | 本提案格式类全过 |
| `Alt+Enter` | 提交这一批 |

设置里的快捷键面板会实时报三类问题：**系统保留**（并说明系统拿它做什么）、**与本应用其他命令重复**、**裸键**。
