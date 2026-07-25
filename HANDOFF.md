# HANDOFF — 实现阶段交接

> 写给接手实现的新会话。**读完本文件即可开工，不需要任何对话历史。**
> 最后更新 2026-07-26。

## 读什么，按顺序

1. **本文件** — 现状、已定决策与理由、下一步
2. `SPEC.md` — 唯一权威设计基准。实现与它冲突时改实现
3. `AGENTS.md` — 工作契约，短，每次开工前重读
4. `prototypes/decision-model/README.md` — 已验证的裁决模型
5. `ROADMAP.md` — 范围与明确不做的事

`README.md` / `README.zh-CN.md` 是对外说明，不含实现信息。

---

## 现状

仓库 https://github.com/kaile9/recension ，只有文档和一个原型，**尚无产品代码**。

已完成：

| 产物 | 状态 |
|---|---|
| SPEC.md | 12 节，含领域语言、模块边界、协议、五家 Harness 台阶与坑 |
| AGENTS.md / README ×2 / ROADMAP ×2 | 完成 |
| `prototypes/decision-model/` | **21 项断言全过**，裁决模型已验证 |
| M0 工具链 | **未开始** ← 下一步 |

---

## 已定决策与理由

**理由比结论重要。** 以下每条都是经过论证的，不要在新会话里重新争论；要推翻必须给出新证据。

### 形态

**Electron 43.2.0（Chromium 150.0.7871.129），不用 Tauri。**

判据不是框架好坏，是**谁掌握引擎版本**。Chromium 149.0.7827.54→.103 之间存在中文 IME 回归：contenteditable 吞掉合成首字、中文标点要按两次。三份一手证据见 SPEC §4.1。WebView2 Evergreen 由微软推送，应用无法钉版本与回滚；Electron 把 Chromium 钉在包里。

用户已实测四壳四判据当前引擎未复现，但测试者自己标明了置信度边界：**SendInput 固定间隔发键，覆盖不到不规则打字下的 TSF 竞态**。因此结论是放宽版本、**保留门禁**。

### 语言与栈

TypeScript 7.0.2 strict · Bun 1.3.14 · Svelte 5.56（仅外壳）· ProseMirror 1.42（编辑器内核，零框架）· Biome 2.5.5。

**不引 Rust。** Bun 内核已是 Rust（仓库 64.6%），文件 IO、SQLite、哈希跑在 Rust 上。项目自身代码负责领域逻辑，瓶颈是正确性与可改性，而贡献者生态在 TypeScript。留一扇门：M0 性能门禁中某个具体操作过不了线，就把**那一个函数**下沉，不改写整层。

### 三条被推翻的早期设计

新会话若读到旧计划文件，注意这三条**已作废**：

1. ~~压缩即永久冻结 Agent~~ → 改为**标记谱系不可证，由人决定**。原规则会让用户每天办数次身份葬礼，且把大多数 harness 挡在门外。
2. ~~一个 Run 只能绑定一个连续 Edit Scope~~ → 改为**多个互不相交的 Edit Scope**。原规则把「通读全章给出十处分散修改」这个最有价值的用例排除了，且成本高十倍。
3. ~~Adapter 14 项准入门槛~~ → 改为**三级台阶 + 降级标注**。原规则下 Hermes 会被挡在门外，而它是用户自己在用的。

### Harness 台阶（已逐一核实源码/文档）

Codex、Claude Code、Pi、Kimi Code 为 **L2**；Hermes 为 **L1+**。

每家的推荐入口、证据、以及**必须写进 Adapter 的坑**见 SPEC §6.3 和 §6.4。那张坑表是四个子代理读源码得来的，不要凭印象重写。特别注意：

- **Pi 禁用 Node `readline` 解 RPC 帧**（会在 JSON 字符串内合法的 `U+2028/U+2029` 处误切）
- **Claude Code 记账用 `modelUsage` 不用 `usage`**，且官方警告美元金额不可用于计费
- **Hermes `/v1/runs` 传 `model` 必须同时传 `provider`**，否则被静默丢弃

---

## 原型已验证什么

`bun prototypes/decision-model/drive.ts` → 21 passed, 0 failed。

三个值得记住的行为：

- **竞争提案撞在同一 scope 上时整批拒绝并指名冲突**，不按列表顺序选赢家
- **`accept-modified` 之后审计链是活的**：正文是人的措辞，Proposal 仍是 Agent 原文
- **漂移在 commit 时被捕获**，不强行套用、不隐式三方合并

`model.ts` 是纯的，可整块搬进 `packages/core`；映射表见原型 README。

---

## 下一步：M0

**在写第一行业务代码之前把规范变成可执行的。**

```
packages/
  core/      TypeScript, 零 DOM, 零框架
  agent/     Agent Host + Harness Adapter
  editor/    ProseMirror, 零框架
  ui/        Svelte 5
apps/
  desktop/   Electron, 只做窗口与打包
e2e/
  ime/       IME 门禁
```

任务：

1. monorepo 骨架 + `bun install` 可用
2. `biome.json`（两空格、100 列、双引号、分号、尾随逗号、import 排序）
3. `tsconfig.json`（TS 7 strict）
4. CI 三道门：`fmt:check` → `check` → `test`
5. **用真实 core 代码跑通 TS 7 + Bun + Svelte 完整构建链路**

第 5 条是真正的门禁。TypeScript 7 是 Go 重写的原生编译器，与旧构建工具链的兼容性**必须实测**，不能假设。若发现坑，在 SPEC §12 记录并给出退路。

验收：三道门全绿，且 M0 结束时 `packages/core` 里已有从原型搬过来的裁决模型与它的十个测试场景。

---

## 需要用户提供的东西

1. **IME 门禁工程**在用户 Windows 机器的 `C:/Users/<author>/ime-acceptance-test/`，需要放进 `e2e/ime/`。当前会话读不到该路径。
2. **产品名已定 Recension**，但用户当时未最终确认（我在超时后按判断决定）。备选：Chirograph、Apograph、Vellum。改名成本低。

---

## 陷阱

- **不要在 `/workspace` 根目录 `git init`** —— 那是用户 13GB 的总工作区。仓库在 `/workspace/projects/stet/`（目录名未随仓库改名，无碍）。
- **凭据不落盘。** 用户曾把 GitHub token 贴在对话里；push 时用环境变量、单次调用内 `unset`、remote 换回无凭据 URL、事后 grep 核验四处（git 历史、`.git/config`、文件、env）。
- **断言通过不等于功能正确。** 改界面看渲染像素，改协议跑真实往返，升 Electron 跑 IME 门禁。
