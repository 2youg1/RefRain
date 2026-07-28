# AGENTS.md

一个本地写作工作台。Agent 提出的每次编辑是可审对象；手稿留在人的手里。

设计权威是维护者本机的 `SPEC.md`（**不入库**）。在本机工作时：代码与 SPEC 冲突，改代码；SPEC 没有回答的决定，追加到 SPEC §14 后继续做能确定的部分，不发明。SPEC 不在场时（外部贡献者），以本文的不变量与 `docs/architecture.md` 为准，拿不准的开 issue 问，不猜。

## 实现方式

- 实现类工作一律加载 **implement skill** 并按其流程推动：读 spec/ticket → 定切片 → 先红后绿 → 真实路径证据 → 收尾核对。不徒手即兴。
- 回答用户问题先答问题，再动手改代码。
- 对用户的反馈或分析，先明说同意还是不同意，再说改了什么。
- 回复短而直接；commit、issue、PR、代码里不用 emoji，不写客套填充。

## 起步

```bash
bun install
bun run generate      # specta → bindings.gen.ts / errors.gen.ts / fake.gen.ts
bun run dev           # tauri dev
bun run gate          # fmt:check → check → test → 本平台全部 verify:*
cargo test --workspace --all-targets
```

本机工具链（Rust、Bun、Tauri CLI、msedgedriver 等）已备妥。不要重装、不要「以防万一」跑安装命令；先 `command -v` 探测，缺了才报告。

## 动手之前

- 大范围修改、审计、或编辑没有完整读过的文件之前，整读文件；不依赖搜索片段做广泛改动。
- 改函数签名前读全部 caller；改状态转移前读全部持久化读者与失败路径。
- 删除看起来是有意为之的功能或代码之前，先问。
- 不为过时依赖的类型报错降级代码；升级依赖。
- 外部 API 的类型去 node_modules / crate 源码里查证，不猜。

## 不变量

违反任何一条是缺陷，不是风格分歧。全表在 SPEC §4（十六条），每条有具名门禁且被注入证明会咬过。日常最常撞到的七条：

1. **零出网。** 应用进程不发任何出站请求；无 API key、遥测、自动更新。模型调用只发生在用户自己的 harness 里。
2. **只有 Text Action 改手稿。** Agent 输出止于 Proposal；合并需要人的点击。手稿写入口只有 `apply_editor_action` 与 `commit_decision_batch` 两条 command。
3. **无计费数学。** 不显示价格与成本估算；token 按 harness 原样转述，三态 `actual / estimated / unknown`，unknown 永不写成零。
4. **Source Backup 永不写入；删除只进系统回收站。** 任何层无永久删除；回收站不可用时操作失败、文件留在原地。
5. **IME 组合中的文本不是文本。** 不读回、不落盘、不替换 composing node；组合期零 Tauri command；组合中的保存延迟到 `compositionend`。
6. **每个持久事实恰有一个 owner。** Vue 不复制状态机；视图关闭不改变数据寿命；桥上只走 JSON 平面 DTO 与不透明 ID，响应式代理不作 command 入参。
7. **Host 独占编排状态。** adapter 返回事实（Receipt/Outcome），不改 Run；已落盘的外部效果不回滚；进程退出不是完成。

## 边界

- `refrain-core`：纯领域。不依赖 tauri、SQLite、文件路径、进程、DOM。类型名不属于领域词汇表的，不进这里。
- `refrain-store`：全部可变磁盘路径与两个数据库的唯一 owner。其他 crate 不用 `std::fs` 写项目。
- `refrain-host`：只写 Run workspace；经 trait 读冻结 Context。
- `src-tauri`：组合层。每个 command 一行映射到具名 use case，不保存第二份业务状态。
- `packages/editor`：ProseMirror adapter，framework-free TS。唯一触碰版心 DOM 的模块；不 import Vue、不 import 生成绑定。
- Vue：只渲染 Rust 返回的判别联合；不推断权限、终态、token 口径；不从按钮存在与否反推状态。`App.vue` 只做挂载与 provide。
- `src/generated/`：生成物，禁手改；重生成后 diff 必须为空。

## 风格

Rust：edition 2024，clippy `-D warnings`；判别联合表状态机，`match` 穷尽；错误是带 code/action/subject/recovery 的领域结果，不跨边界传裸字符串。trait 只出现在真实替换边界（HarnessAdapter、Clock/Id/Store 测试端口），不为「以后也许」给每个 struct 建 trait。

TypeScript：strict；Rust 之外一律 TS，仓库不出现手写 `.js`。`any` 禁止（`unknown` 是正确的边界类型）。顶层 import，不用内联 `await import()`。只有一个调用点的单行 helper 就地内联。

两种语言共同的：一行表达一个完整想法；删解释性临时变量、仪式化控制流、只改名的包装。抽象三选一才存在——执行一条不变量、隔离一处已知易变、命名一个组合中使用的概念；三者皆无，三行相似代码胜过一个早熟抽象。不设 `utils/helpers/common` 垃圾层。不为没人要求的向后兼容付费。

领域词汇单一权威——`Text Head`、`Revision`、`Proposal`、`Review Slice`、`Verdict`、`Edit Scope`、`Run`、`Dispatch Authorization`。代码、注释、UI 文案、测试名用同一个词，不造同义词。

标识符用英文；注释只写*为什么*。软上限：400 行每模块、一屏每函数——超过须能说出该模块为何仍只拥有一个概念。

键位与文案：不硬编码按键检查；一律进默认绑定表，提示文字由生效绑定生成。发现一条独立维护的提示字符串，按缺陷处理。

## 测试

三道门全绿，PR 才落地：

```bash
bun run gate && cargo test --workspace --all-targets
```

- 不变量各有门禁（`verify:roundtrip / scale / no-network / trash-only / write-path / bridge / composition / copy-projection / docs-current / citations / gates-run`），每条都曾以注入缺陷证明会咬。**一个不会失败的门禁比没有门禁更糟。** 新门禁先注入它声称能拦的缺陷、看它变红才可接入 CI；注入前先证明注入本身落地（编辑操作拒绝 no-op）。
- 门禁输出不进管道尾截：`… | head` 会吃掉退出码。
- 创建或修改了测试文件，就运行它并迭代到通过。
- 测试主力在 `refrain-core`（属性测试、语料、状态机穷举）。浏览器与组件测试只用 `fake.gen.ts` 派生的 typed fake；手写 `invoke(` 或 `__TAURI__` 出现即门禁红。adapter 用合同测试对真实会话运行。
- 写断言前先说出「失败时世界长什么样」，并确认门禁能到达那个状态；teardown 放断言之后；宁断言「必须主动产生的东西」，不断言「某物不存在」。
- **绿色断言不是正确。** 改 UI 要看真实渲染像素；改协议要走真实往返。`e2e:ime` 是每晚必跑项：WebView2 Evergreen 跟随系统更新，IME 回归要在 CI 上先被看到。
- Linux 全绿对 Windows 不构成证据——Windows 是唯一发布平台，七类「Unix 宽容、Windows 强制」缺陷记录在案（只读句柄 fsync、构造失败泄漏文件锁、`Path` 大小写、junction 删除形态等）。Windows required job 不可替代，不可 `continue-on-error`。平台缺陷互相掩盖：修完一批才看得见下一批。

## Git

同一 cwd 可能有多个 agent 会话并行，各改各的文件。凡触碰自己改动之外的 unstaged/staged/untracked 文件的 Git 操作都会毁掉别人的工作：

- 只提交**本会话你改过的**文件；`git add <path1> <path2>` 逐路径 stage，**永不** `git add -A` / `git add .`。
- 提交前 `git status` 核对只 stage 了自己的文件。
- **永不运行**：`git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git commit --no-verify`、force push。
- rebase 冲突只解决自己改过的文件；冲突落在没改过的文件上，abort 并问用户。
- 用户没让提交就不提交。
- Commit message：`{feat,fix,docs}(core|store|host|editor|desktop): <一句话>`；一个 commit 做一件事，一句话说不完就拆。生成物与手写代码分开提交。

## 依赖

- 依赖与 lockfile 变更按被审代码对待；直接外部依赖钉精确版本。
- 装依赖用 `bun install --frozen-lockfile`；不跑生命周期脚本，除非用户要求。
- 新依赖在 PR 写明：删除了哪些自有代码、维护责任、是否触及零出网与供应链。只包装语法的依赖不进。

## Pull request

四段缺一不可：**问题**（症状与复现）、**方案**（取舍与被拒项）、**实现**（致密 diff）、**证据**（三道门 + 该片要求的真实路径）。

给人审阅的工件（主题预览页、图标、方案对比）必须先提交进仓库再提请裁定——裁定结果写回权威文档，不留在对话里。

## 用户覆盖

用户指令与本文规则冲突时，先指出冲突并请求明确确认，确认后才按用户指令执行。
