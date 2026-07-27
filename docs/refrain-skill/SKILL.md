---
name: refrain
description: RefRain 写作工作台的 agent 协议。当你收到一份含 "# Before / # Request / # Reply format / # Agent reply" 四段的请求文件时，加载本 skill。它告诉你请求怎么来的、你必须怎么回、人类会看到什么、你会收到什么反馈。
---

# 你在 RefRain 里工作

RefRain 是一个本地写作工作台。一个人在里面写长稿，把某几段交给你改。

**你写的是提案，不是正文。** 你的每一个字都要经过那个人点一次鼠标才会进入手稿。没有自动接受，没有后台合并。

---

## 一分钟版本

```
人选中几段 → 变成一份请求文件 → 你回一个 <agent-result> → 人逐条裁决 → 裁决回传给你
```

四件事，记住就够了：

1. **只回一个 `<agent-result>` 元素。** 前后不能有任何字，包括「好的，我来改」。
2. **scope id 照抄。** 从 `# Before` 里抄，一个字符都不能变。
3. **一个 scope 最多一个 `<replacement>`。** 重复 = 整个 run 失败。
4. **不想改就别写 `<replacement>`。** 只写 `<comment>` 是合法的，也是你表达怀疑的方式。

---

## 第一步 · 请求是怎么来的

那个人在编辑器里选中若干段落，写一句要求，点发送。RefRain 生成一份文件给你，长这样：

```markdown
# Before

<!-- scope ch01:b3 -->
这里是第三段的原文。

<!-- scope ch01:b4 -->
这里是第四段的原文。

# Request

把这两段的语气改得更克制。

# Reply format

（协议全文，见下一节）

# Agent reply

<!-- Your <agent-result> element replaces this comment. -->
```

**四段各归谁**：`# Before`、`# Request`、`# Reply format` 由应用生成；`# Agent reply` 是你的，只有你的。

**scope id 就是段落的身份**（形如 `ch01:b3`）。它不是给你看的编号，是应用用来找回那一段的钥匙。抄错 = 找不到 = 你的改动被拒。

---

## 第二步 · 你必须怎么回

这是应用发给你的原文契约，逐字如下：

```
Reply with one <agent-result> element and nothing else — no
preamble, no closing remark, no code fence. Text outside the element is
rejected and the run fails.

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
- Omit <replacement> entirely to propose no change; comments alone are valid
  and are how you raise a doubt without editing.
- You are writing a proposal, not the manuscript. A human reads every change
  and decides. Nothing you write reaches the text without that decision.

About <memo>: write it for whoever works on this next — possibly you after a
compaction, possibly a different agent. Record what you learned that is not
already visible in the text: the author's standing preferences, decisions
already settled, traps you found. Skip anything a reader could see by opening
the manuscript. It is optional, it is read by a human before it is reused, and
it is the only thing you carry across a lost context.
```

### 三个致命细节

| 细节 | 写错的后果 |
|---|---|
| `<comment>` 用 `target=`，**不是** `scope=` | 解析失败，整个 run 作废 |
| `<comment>` 必须**包在** `<comments>` 里面 | 同上 |
| 元素外不能有任何文字，**包括代码围栏** | 同上 |

被测过的六种回法里，**五种失败**：裸散文、包在代码块里、加一句客套开头、漏掉 `version` 属性、猜错元素名。这五种恰好是多数模型的默认行为。

### 一个可以照抄的例子

```xml
<agent-result version="1">
  <replacement scope="ch01:b3">改写后的第三段。</replacement>
  <comments>
    <comment target="ch01:b4">第四段的引文出处我无法核实，没有改动。</comment>
  </comments>
  <memo topic="语气">这位作者不接受设问句结尾。已第三次遇到。</memo>
</agent-result>
```

注意这里做了一件事：**b4 只留评论、不给替换**。这是正确用法——你拿不准就不要改，说出来。

---

## 第三步 · 关于 `<memo>`

这是应用原文的说明：

> 写给下一个接手的人——可能是压缩之后的你，也可能是另一个 agent。记下你学到的、但打开手稿看不出来的东西：作者的长期偏好、已经定下的决定、你踩到的坑。凡是读者打开手稿就能看到的，别写。它是可选的，会先被人读过才被复用，它是你在丢失上下文之后唯一能带走的东西。

写 memo 的判断标准只有一条：**打开手稿能看到的，不写；只有经历过这次对话才知道的，写。**

- 好：「作者反复删掉我加的过渡句，他要段落之间硬接。」
- 坏：「本章讲的是 1930 年代的农村金融。」（打开就看得见）

---

## 第四步 · 人会看到什么

你的回复**不会**直接进入手稿。它被冻结成一份**提案**，然后被切成**评审切片**——按句子切，中文和西文都切得开。

那个人看到的是一句一句的对照，对每一片做一次**裁决**：

| 裁决 | 意思 |
|---|---|
| 接受 | 用你的句子 |
| 拒绝 | 保留原句 |
| 改后接受 | 他自己改了一版，用他的 |

每次裁决可以附一句**理由**。全部裁决完，他再点一次「合并」，文字才真正进入手稿。

**所以**：你的一次回复里，有的句子会被采纳，有的不会。这是设计，不是失败。

---

## 第五步 · 你会收到什么反馈

下一轮请求里，你可能会看到这段：

```xml
<changes>
<verdict n="1" ref="p7.s2" kind="accept">
  <reason>这句改得对</reason>
</verdict>
<verdict n="2" ref="p7.s5" kind="reject">
  <reason>不要用设问句结尾</reason>
</verdict>
<verdict n="3" ref="p7.s8" kind="accept-modified">
  <final><![CDATA[他最后采用的版本]]></final>
  <reason>意思对，但太长</reason>
</verdict>
</changes>
```

**这是这个软件真正的东西。** 那个人不只是接受或拒绝，他还告诉你为什么。这些理由会累积。

读到它时：

- `reject` + 理由 → **这是一条规则，不是一次意见**。同样的错不要犯第二次。
- `accept-modified` 的 `<final>` → 他实际想要的样子。对照你写的那版，差别就是你要学的。
- `accept` → 方向对，继续。
- `comment-only` → 他只留了话，没动这一片。

`ref` 指向的是切片（形如 `p7.s2`，即第 7 号提案的第 2 片），不是你写的 scope id。

---

## 请求里各段的顺序，以及为什么

一次完整的请求按这个顺序拼：

```
persona（你是谁，作者写的）
manuscript（全文，仅在需要时）
changes（上一轮的裁决）
changelog（作者自己改了什么）
request（这次要你做什么）
```

**稳定的在前，每轮变的在后。** 因为 harness 按前缀逐字节匹配缓存——把变动的东西放前面，会让后面每一个 token 的缓存在每一轮全部失效。

你不需要做什么，知道就行：**开头那部分你上次见过，是同一份。**

---

## 三件这个软件不会做的事

| 它不做 | 意味着 |
|---|---|
| 不联网 | 它自己不调用任何模型。跑你的是那个人自己的 harness |
| 不替你算钱 | 它只如实转述 harness 报的 token 数；harness 没报就显示「未知」。它不做单价换算 |
| 不自动合并 | 你的字进入手稿的唯一路径是那个人点鼠标。没有 YOLO 模式 |

---

## 出错时

| 报错 | 你做错了 |
|---|---|
| `text-outside-root` | 元素外面有字。检查开头的客套话和代码围栏 |
| `duplicate-replacement` | 同一个 scope 写了两次 `<replacement>` |
| `missing-scope` | `<replacement>` 少了 `scope=` |
| `unknown-element` | 用了协议之外的标签名 |
| `unsupported-version` | `version` 不是 `"1"` |
| `missing-root` | 找不到 `<agent-result>`。它必须在 `# Agent reply` 这一节里 |
| `dtd-forbidden` | 写了 DOCTYPE 或实体声明。这个格式不接受 |
| `too-deep` | 嵌套超过 8 层 |
| `malformed` | 标签没闭合。**逐字检查每个 `>`** |

出错时整个 run 作废，那一轮的 token 白花。**回复之前，把你写的最后一个字符看一遍**——它必须是 `<agent-result>` 的那个 `>`。
