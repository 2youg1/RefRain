# RefRain

一个本地写作工作台。Agent 的每一处修改都是一份可审阅的提案，稿子始终在人手里。

[English](README.md) · GPL-3.0-only

---

## 这是什么

用 Markdown 写作。把一段文字交给你已经在用的编码 Agent——Claude Code、Codex、Pi、Kimi，或你自己的脚本。回来的是**提案，不是既成事实**：你逐句读，留下站得住的，驳回其余的，并写下理由。理由会被保存、可检索，并随下一轮请求送回去。

三条公理，按优先级：

1. **文件即真相。** 磁盘上的 Markdown，不装这个软件也能编辑、也能进 git。
2. **提案即数据。** Agent 的修改是可审阅的对象，不是已经发生的事。
3. **裁决即回复。** 接受、驳回、改后接受、批注——全部序列化回传给 Agent。

## 裁决账本

人对 Agent 输出的每一次判断——接受、驳回、改后接受，以及**为什么**——都是一等公民数据：落盘、可搜、可累积。

现有工具把裁决当作一次性的界面事件。点了接受，理由就蒸发了。把它留下来，就有了三样别处没有的东西：

- **回复。** 裁决进入下一轮 prompt。Agent 知道上一稿为什么被驳回。
- **口味。** 累积的裁决是这位作者判断力的样本——不需要训练，只需要检索。
- **审计。** 一部完成的作品可以说清：哪一句是人写的，哪一句是 Agent 提的，哪一句是 Agent 提了、人改过。

编辑器会过时，Harness 一年一换。账本两者都不会。

## 它不会做的事

做了以下任何一件都是缺陷，不是欠缺的功能：

- **不出网。** 应用进程不发出任何外部请求。无 API key、无账号、无遥测、无自动更新。所有模型调用都发生在你自己的 Harness 里。
- **不自动合并。** 没有 YOLO 模式，没有自动接受，没有后台合并，Agent 不能自我裁决。没有任何设置、参数或插件能绕过人的那一次点击。
- **不替你算钱。** 不显示价格，不做成本估算。Token 数原样回传 Harness 报的数字，标注 `actual` / `estimated` / `unknown`。Harness 什么都不说时，界面就显示未知。
- **不永久删除。** 删除进系统回收站——Windows 走 `IFileOperation`，macOS 走 `NSFileManager`，Linux 遵 freedesktop 规范。任何一层都没有永久删除，一旦出现 CI 就失败。

## 速度

文件层是一个 Rust crate（`packages/fs`），通过 N-API 调用。它存在的理由是四件事落在交互路径上，而 JavaScript 做不到那么快。

2 万文件的目录树，热缓存，10 次运行取 p50：

| 操作 | p50 | p95 |
|---|---:|---:|
| 扫描 2 万文件 | 10.38 ms | 11.33 ms |
| 按名称自然排序 | 0.80 ms | 0.94 ms |
| 子串搜索 | 6.66 ms | 8.22 ms |
| 子序列搜索 | 7.71 ms | 10.24 ms |
| 中文搜索 | 5.88 ms | 6.99 ms |
| 取 200 行 | 0.13 ms | 0.17 ms |

每一项交互操作都落在 120 Hz 的 8.3 ms 帧预算内。索引留在 Rust 里，渲染层只拿它能显示的那些行——2 万条目的工作区，DOM 里约四十行。

数字按读者读的方式排序：`chapter-10` 在 `chapter-9` 之后。搜索偏移是字符偏移，所以中文文件名高亮的是你键入的那个字，而不是它中间的某个字节。

## 显示器

关于你的屏幕有两件事会改变绘制方式，而且构建时都不可知。

**刷新率。** 时长按实测帧率的**帧数**表达。八帧在 60 Hz 是 133 ms，在 165 Hz 是 48 ms——在两块屏上是同一个手势，而不是被钉死在开发者手头那块屏上。把窗口拖到另一块屏，目标会跟着变。

**像素密度。** 发丝线是一个物理像素，不是一个 CSS 像素。300% 缩放下的 1px 边框是三像素的模糊，而这个应用的基线网格正是由发丝线构成的。

## 上手

```bash
bun install
bun run native     # 为当前平台构建 Rust 文件层
bun run dev
```

`bun run native` 需要 Rust 工具链和系统 C 编译器。机器上没有 `cc` 时，先 `source scripts/native-env.sh`——它让 cargo 走 Zig，后者在一个压缩包里带了完整的 C 工具链。

项目就是一个装着 Markdown 文件的普通文件夹。打开它，`Ctrl K` 唤出全部命令。

## Harness 支持

适配层按「Harness 能证明什么」分档，不按偏好：

| 档位 | 含义 |
|---|---|
| **L0** | 文件通道。Agent 读 `request.md`，写 `result.md`。任何能读写文件的东西都能接。 |
| **L1** | 命令。RefRain 启动你的 Harness 并收取结果。 |
| **L2** | 会话。Harness 报告自己的模型、思考强度与 token 用量，RefRain 原样转述。 |

目前 L0、L1 与首个 L2 适配（Claude Code）已可用，其余 L2 适配陆续跟上。任何一档都是能用的——档位说的是 RefRain 能告诉你多少，而不是它跑不跑得起来。

## 构建

```bash
bun run gate       # fmt:check → check → test，三道全绿才算数
bun run native     # 平台二进制
cd apps/desktop && ./make.sh && bun x electron-builder --linux AppImage
```

Windows、macOS、Linux 的产物由 `gate` workflow 产出，它会先在每个平台上构建并测试原生层，再跑其余检查。

## 验证

测试通过不等于正确。除单元测试外：

- `bun run verify:no-network` —— 没有外部请求能到达应用进程
- `bun run verify:trash-only` —— 任何一层都不存在永久删除
- `bun run verify:gate` —— 类型门禁确实会失败
- `apps/desktop/scripts/verify-files.ts` —— 按渲染后的实际几何测量文件浏览器：虚拟列表、表头落在自己数据的正上方、发丝线是一个物理像素
- `apps/desktop/scripts/verify-grid.ts` —— 界栏落在字下面，不穿过字
- `e2e/ime` —— Windows + 微软拼音，四种外壳，真实 `SendInput` 输入。升级 Electron 前必跑。

## 文档

| 文档 | 内容 |
|---|---|
| [`SPEC.md`](SPEC.md) | 权威设计基线。代码与它冲突时，改代码。 |
| [`AGENTS.md`](AGENTS.md) | 在这个仓库里怎么干活：不变量、风格、门禁。 |
| [`docs/STATUS.md`](docs/STATUS.md) | 当前状态、已知缺陷、哪些尚未验证。 |
| [`docs/TEST-MATRIX.md`](docs/TEST-MATRIX.md) | 已有的每一项测试，和应该有的每一项。 |

## 许可

GPL-3.0-only。一个会读你稿子的写作工具，应当是你也能读回去的。
