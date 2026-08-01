<div align="center">

# RefRain

**本地长稿写作台：智能体只能提议，合并权在你手里。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![下载](https://img.shields.io/github/v/release/kaile9/RefRain?label=%E4%B8%8B%E8%BD%BD&color=blue)](https://github.com/kaile9/RefRain/releases/latest)

</div>

---

## 它要解决什么

让智能体直接改稿，快，但没人负责。你最后要靠读 diff 才知道自己的书被动过哪里，
而那个还说得通的版本已经落在身后某处。

让智能体只聊天，有人负责，但没用。文字复制出去、粘贴回来，思路每次都断一遍。

RefRain 取第三种立场：**智能体提议，你裁决，而谁裁决了什么本身就是文稿的一部分。**

<p align="center">
  <img src="docs/images/composer.png" alt="发送台：一层半透明表面浮在正文之上" width="720">
</p>
<p align="center">
  <img src="docs/images/rail-and-menu.png" alt="侧栏与发送信箱，以及两分区的右键工作区" width="720">
</p>
<p align="center">
  <img src="docs/images/kara.png" alt="KARA：屏幕顶部 20% 的渐透明滤镜" width="720">
</p>

## 怎么运作

你圈定智能体能看到的段落。RefRain 把这些字节原样冻结成一份请求——所选段落逐字、
上下文、契约、摘要——然后才发出去。

智能体回来的是替换方案。RefRain 拿它与**冻结的那份请求**核对，而不是听信智能体自己
的说法；于是一个已经对不上你文本的提议会当场失败，而不是落在一段智能体根本没读过
的文字上。

你可以接受、改着接受、或者打回去。这个裁决被记下来。到这时你的文字才改变。

## 这个软件不做的四件事

每一条都有门禁守着，破坏它构建就会红：

| | |
|---|---|
| **不联网** | 应用进程不开任何 socket。你的稿子在你的硬盘上，就留在那里。 |
| **不替你合并** | 智能体只产出提议。没有一条裁决记录，任何东西都进不了正文。 |
| **不写你的原稿备份** | `.refrain-source/` 保存你纳入这个文件夹那一刻的原始文件，永久只读。 |
| **不真删** | 删除进回收站。 |

## 你会得到什么

### 写作

整份手稿是一个编辑面，所以选区能跨段落——这本来就是你预期的行为。十万个块里同时
挂载的约六十个，帧调度跟随你显示器的刷新率。

对中日文作者尤其要紧的几点：输入法组合过程绝不被打断，保存会等 `compositionend`；
三个字体槽（拉丁、中文、日文）按优先级决定汉字由谁来渲染，而不是碰运气。

排版归你控制——字重、字距、词距、行宽、缩进、段距、对齐、基线网格、显示缩放——中、
日、英各有预设，也留了你自己的位置。围栏代码块支持八种语言六套配色，全部在构建期
内嵌，所以高亮永远不会去联网取任何东西。

还有些每天都会碰到的小事：标点宽度建议、空段清理、不会留下 `****` 残渣的三态行内
格式、标题引用列表的三态命令、宁可请你重新锚定也不乱猜的批注，以及保存失败时告诉
你下一步该做什么。

### 与智能体协作

本地 harness 会被自动发现并连上，你不需要知道任何路径。你可以直接从一条批注派出
一单。

一轮里可以有多个智能体：互不相干各答一遍的**并列**、读取上游产物的**承接**、以及
审阅他人工作的**校验**——校验者可以报告问题，但不能提议改动。

参考文档随请求走的是**清单**而不是全文。三份 100KB 的参考资料只占约 1,250 字节而不是
30 万，智能体自己决定要取哪些——你不必为了给它一座图书馆而付钱，何况它多半不会翻开。

每一次裁决都落进 **Verdict Ledger**：逐句记下接受、改着接受、还是打回。

### 规模

在开发机上实测，不是估算：

| | |
|---|---|
| 1GB Markdown | 能打开——720 万个块 |
| 11.4MB 手稿，10 万块 | 打开到 JSON，p95 68ms |
| 100MB PDF 导入 | 195ms 解析完 |
| 10 万文件的项目目录 | 热态 p95 404ms |

## 安装

到 [Releases](https://github.com/kaile9/RefRain/releases/latest) 下载 Windows
安装包。缺 WebView2 时由引导程序装上。

macOS 与 Linux 在计划内但尚未发布：本仓库里的每个数字都出自 Linux，而在某个平台上
实测之前，不会替那个平台作任何声称。

### 从源码构建

需要 Rust 工具链与 [Bun](https://bun.sh)：

```sh
bun install
bun x tauri build
```

提交前跑齐四道检查——Rust 那三道不在 `bun run gate` 里面：

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
bun run gate
```

## 文档

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 模块、术语表，以及出了问题最可能在哪
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — 怎么提改动
- [ROADMAP.md](docs/ROADMAP.md) — 计划中的东西
- [AGENTS.md](docs/AGENTS.md) — 智能体在本仓库里的工作纪律
- [SKILL.md](docs/SKILL.md) — 智能体协议，由解析器生成

## 技术栈

| | |
|---|---|
| **内核** | [Rust](https://rust-lang.org) — 领域模型、存储、智能体编排 |
| **桌面外壳** | [Tauri](https://tauri.app) + [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |
| **界面** | [SolidJS](https://solidjs.com)、`strict` 下的 [TypeScript](https://www.typescriptlang.org)、[Biome](https://biomejs.dev) |
| **编辑器内核** | 无框架直接操作 DOM；正本字节归 Rust 所有 |
| **存储** | [SQLite](https://sqlite.org)（经 [rusqlite](https://github.com/rusqlite/rusqlite)）；FTS5 `unicode61` 配应用层 bigram 分词 |
| **标识** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) 摘要、[UUID](https://github.com/uuid-rs/uuid) v7 |
| **类型桥** | [Serde](https://serde.rs) 与 [Specta](https://github.com/specta-rs/specta)，TypeScript 类型由后者生成 |
| **高亮** | [Shiki](https://shiki.style)，入口精确注册，运行期不触网 |
| **构建与发布** | [Bun](https://bun.sh) 与 [Node.js](https://nodejs.org)，仅构建期使用；[ScriptC](https://github.com/vercel-labs/scriptc) 把发布策略编译成原生可执行文件 |

搜索索引为什么用 bigram 而不是 trigram 或分词器——连同定下这件事的实测数据——写在
[ARCHITECTURE.md](docs/ARCHITECTURE.md#why-bigram-not-trigram-or-a-tokeniser)。

## 许可

[MPL 2.0](LICENSE)。

## 致谢

**[Shiki](https://shiki.style)**（MIT）提供语法高亮。RefRain 精确注册它的入口，使
高亮永不触网——这一点是这个库让我们做到的，而不是我们跟它较劲得来的。

内嵌的字体，均遵循
[SIL 开放字体许可 1.1](https://openfontlicense.org)：

- **[Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)** — 20,976 个汉字外加假名，中文稿不出豆腐块靠它
- **[Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New)** — 6,682 个汉字，用于日文
- **[Antic Didone](https://fonts.google.com/specimen/Antic+Didone)**
- **[Jost](https://indestructibletype.com/Jost.html)**
- **[Courier Prime](https://quoteunquoteapps.com/courierprime/)**

第三方完整条款在 [LICENSE-THIRD-PARTY](LICENSE-THIRD-PARTY)。
