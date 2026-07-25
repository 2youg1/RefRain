# 路线图

*[English](ROADMAP.md)*

---

## 当前 — v0.1

Windows 优先。一位作者、一个本地项目、多个本地 Agent、章节化 Markdown。

首发必须走通的路径：

```
建立项目 → 正常写作 → 选段落、写 Prompt、挑 Agent
→ 攒进待发队列 → 一次点击发送
→ Harness 执行并写 Result Artifact
→ 应用冻结 Proposal 与 Review Slice → 人逐条裁决
→ Decision Batch 产生新 Text Head → 裁决落入账本
```

**首发包含**

- 事务化正文：Text Action、Text Change、Text Head、Revision、选择性撤销
- Source Backup 与崩溃恢复
- 攒批送审与合并发送清单
- Result Artifact 校验、Proposal、Review Slice、三方冲突比较
- Verdict Ledger：裁决落盘与回传序列化
- 正文幽灵对比与独立检阅窗口
- 多 Agent 竞争提案
- 五家适配器——Codex、Claude Code、Pi、Kimi Code 为 L2，Hermes 为 L1+
- L0 文件通道，任何 Harness 立刻可用
- Agent 全部离线时，正文路径依然完整

**首发的视觉范围**

只做一套克制的中西文排版：字号、行距、字距、页宽。配色与动效等真实长文渲染出来之后再长——**审美从像素里长出来，不从规格里长出来**。

## 接下来

**v0.2 平台与手感**
macOS 版本 · 检阅画布，竞争提案自由排布比较 · minimap 与待决密度 · 同基线分支对比 · 命令面板与快捷键自定义

**v0.3 账本的用途**
裁决攒够之后才成立的功能：按理由、Agent、章节检索历史判断 · 把同类裁决打包进下一轮 Prompt，让 Agent 知道这位作者一贯否掉什么 · 创作溯源视图，显示哪一句是人写的、哪一句是 Agent 提议的、哪一句是 Agent 提议而人改过的

**v0.4 编排**
跨会话对白：两个会话各持一角，工作台居中传话若干轮，整段交锋作为一条 Proposal 送审 · 基于 AgentSwarm 的批量扇出（Kimi Code 支持最多 128 个 subagent）· 每一轮仍由人点击推进；Automation Grant 必须设轮次上限，且每轮写入可见队列

**v0.5** Linux 版本

## 插件

**首发定接口，不做加载器。**

两组公开接口先冻结，将来插件挂在同一形状上：`HarnessAdapter`（SPEC §6.2），以及 Review Engine 的 Proposal 与 Slice 接口。

在加载器出现之前，扩展方式是 fork 或 PR。这个顺序是有意的：**被真实使用验证过的接口，比为想象中的插件设计的接口更安全**。

## Harness 兼容

首发五家（SPEC §6.3），清单靠贡献生长。

| 台阶 | 工作量 | 换来什么 |
|---|---|---|
| L0 文件 | 几十行 | 该 Harness 立刻可用 |
| L1 会话 | 约一天 | 可派发、可取消、可看状态 |
| L2 可信 | 视 Harness 而定 | token 显示实数，上下文预警可信 |

跑到哪级标哪级，README 公示。**能力不足是降级加如实标注，从不是拒绝。**

## 明确不做

以下每一项都会把可验证的原则拉回成需要用户信任的宣称。

- 应用内的模型 provider、API key、账号
- 遥测、云同步、自动更新
- 多人实时协作。若将来实现，两条规则不变：Agent 不直接写正文；Proposal 必须引用明确 Revision
- 远程 Agent 执行
- 拖线式通用工作流编辑器
- 替代 Word 的排版交付——导出是桥，不是主场
- 代码补全与通用 IDE 功能。这是写作台

## 版本

协议走 semver：major 不符拒绝，minor 允许字段增删且解析端容忍未知字段。

Electron 版本钉死可回滚，每次升级先跑 `e2e/ime` 门禁——中文能否打字是资格线，不是性能指标。
