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
日、英各有预设，也留了你自己的位置。围栏代码块支持三十四种语言六套配色，全部在构建期
内嵌，所以高亮永远不会去联网取任何东西。

编辑是可以回头的。Ctrl+Z 撤销上一步，侧栏的「历史」面板能回档到任意一步——记录跨
重启存活。对智能体合并进正文的提案，反悔走另一条路：在邮箱里做一次逆向裁决，冲销
本身也记录在案，账本从不删行。

Markdown 不是唯一可编辑的格式。LaTeX、TypeScript、Rust、Python、Go、Lean 4、CSS、
HTML、XML、TOML、YAML 都能以纯文本打开、编辑、逐字节存回原格式——内嵌高亮按扩展名
选语法，Markdown 的分块与排版机制一律不碰源码。

断行由 RefRain 自己算——因为没有哪个引擎能把中文断对：被它取代的那个只认空格和
制表符，而中文段落两样都没有。RefRain 按 CLREQ 的断行规则来：行尾的全角标点压掉
半个字身，不可分的单元宁可溢出也不硬切，而且断在哪里在三个平台上逐字节一致，
因为算法是一个 Rust 模块，不是三个浏览器引擎。

**换栈进行到哪一步。** RefRain 正在迁到原生渲染路径上。领域层——正文字节、块身份、
裁决、编排、PDF 文本抽取——整体带了过来，且有测试守着。界面按屏重建，所以 v0.2.4
已发布的那些功能（就地渲染、表格、图表、PDF 阅读、批注、搜索结果、历史）
**暂时没有界面**：它们的规则与依赖都还在，每接上一屏就回来一项。
产品没有删掉任何功能，变的是画它的那一层。

还有些每天都会碰到的小事（同样规则还在、界面待接）：搜索结果会把命中的那句话
显示出来、查询词标在里面；标点宽度建议、空段清理、不会留下
`****` 残渣的三态行内
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

RefRain 还没有发布。应用能从同一份清单构建并运行在 Windows、macOS 与 Linux 上，
但没有任何一个平台走过真实的安装流程，所以不提供下载。

本仓库里的每个数字都出自 Linux。在某个平台上实测之前，不会替那个平台作任何声称
——尤其是 Windows 与 macOS 的输入法链路，代码写好了但还没有在真机上签字。

### 从源码构建

需要 Rust 工具链与 [Bun](https://bun.sh)：

```sh
bun install
cd apps/native && ./node_modules/.bin/native build . --yes
```

提交前按这个顺序跑——顺序是承重的：

```sh
bun install
bun run scriptc:build    # tier A 门禁跑的是编译产物
bun run gate             # 它生成 Rust 测试要读的语料
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
mkdir -p .tmp
TMPDIR="$PWD/.tmp" cargo test --workspace --all-targets
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
| **应用外壳** | [Native SDK](https://native-sdk.dev)——原生渲染。交付的二进制里没有 WebView，也没有 JavaScript 运行时。 |
| **界面** | `.native` 标记、受限的 [TypeScript](https://www.typescriptlang.org) 子集（只管界面状态）、[Zig](https://ziglang.org)（平台事件与绘制） |
| **编辑器内核** | 无框架直接操作 DOM；正本字节归 Rust 所有 |
| **存储** | [SQLite](https://sqlite.org)（经 [rusqlite](https://github.com/rusqlite/rusqlite)）；FTS5 `unicode61` 配应用层 bigram 分词 |
| **标识** | [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) 摘要、[UUID](https://github.com/uuid-rs/uuid) v7 |
| **类型桥** | [Serde](https://serde.rs) 与 [Specta](https://github.com/specta-rs/specta)，TypeScript 类型由后者生成 |
| **断行** | `refrain_core::typeset`——自研，因为没有引擎能把中文断对（见上） |
| **高亮** | Native SDK 自带的 `code` 部件——17 门语法编译进二进制，运行期不加载任何语法包，也不触网 |
| **图表** | [nomnoml](https://github.com/skanaar/nomnoml)，gzip 后 26 KB，另有一层转换接受 Mermaid 流程图语法 |
| **导入的原件** | 文本由 Rust 侧的 `lopdf` 抽取——无渲染器、无浏览器引擎。每页的字带一个 `<!-- p.N -->` 页锚，所以一句引文说得出它出自第几页，读者也回得到原件 |
| **构建工具** | [ScriptC](https://github.com/vercel-labs/scriptc) 把门禁与发布脚本编译成原生二进制，其余由 [Bun](https://bun.sh) 跑。两者都不进产物。 |
| **构建与发布** | [Bun](https://bun.sh) 与 [Node.js](https://nodejs.org)，仅构建期使用；[ScriptC](https://github.com/vercel-labs/scriptc) 把发布策略编译成原生可执行文件 |

搜索索引为什么用 bigram 而不是 trigram 或分词器——连同定下这件事的实测数据——写在
[ARCHITECTURE.md](docs/ARCHITECTURE.md#why-bigram-not-trigram-or-a-tokeniser)。

## 许可

[MPL 2.0](LICENSE)。

## 致谢

内嵌的字体，均遵循
[SIL 开放字体许可 1.1](https://openfontlicense.org)：

- **[Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)** — 20,976 个汉字外加假名，中文稿不出豆腐块靠它
- **[Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New)** — 6,682 个汉字，用于日文
- **[Antic Didone](https://fonts.google.com/specimen/Antic+Didone)**
- **[Jost](https://indestructibletype.com/Jost.html)**
- **[Courier Prime](https://quoteunquoteapps.com/courierprime/)**

第三方完整条款在 [LICENSE-THIRD-PARTY](LICENSE-THIRD-PARTY)。
