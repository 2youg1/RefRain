# 状态报告 · 2026-07-26（v0.1.3）

给压缩上下文之后的自己，或者给接手的人。读完这份就能接着干活，不需要翻聊天记录。

---

## 一句话现状

**文件层落地：Rust 原生实现，291 项测试全绿，Linux 端已实机验证。** 界面层新增文件浏览器并通过 15 项渲染断言。Windows 与 macOS 的产物只能由 CI 产出，**尚未在真机验证**。

项目根：`/workspace/projects/stet/`
仓库：`github.com/kaile9/refrain`（产品名 **RefRain**）
三道门：`bun run gate`（fmt:check → check → test）
原生层：`bun run native`（需先 `. scripts/native-env.sh`）

---

## 一、本轮完成的事

### 1. `packages/fs` —— Rust 原生文件层

新包，N-API 暴露。选 Rust 不是偏好，是四件事 JavaScript 做不快：并行目录遍历、SIMD 子串搜索、连续内存上的线性排序、以及三平台都没有 JS 绑定的可恢复删除。

**实测性能**（2 万文件，热缓存，10 次 p50）：

| 操作 | p50 | p95 |
|---|---:|---:|
| 扫描 2 万文件 | 10.38 ms | 11.33 ms |
| 按名称自然排序 | 0.80 ms | 0.94 ms |
| 子串搜索 | 6.66 ms | 8.22 ms |
| 子序列搜索 | 7.71 ms | 10.24 ms |
| 中文搜索 | 5.88 ms | 6.99 ms |
| 取 200 行 | 0.13 ms | 0.17 ms |

除扫描（每次打开跑一次）外，全部落在 120 Hz 的 8.3 ms 帧预算内。

模块划分：

- `guard.rs` —— 路径准入。规范化后判断，`../` 与符号链接逃逸由同一条测试拦下。拒绝 Source Backup、根外路径、以及 Windows 会篡改的文件名（在所有平台都拒，否则稿子换台机器就打不开）。
- `index.rs` —— 并行遍历。用 ripgrep 的 `ignore` crate，尊重 `.gitignore`。名称在遍历时折叠一次，不在每次按键时重复分配。
- `search.rs` —— `memchr` 的 SIMD 子串匹配 + 带间隙惩罚的子序列匹配。**按字符而非字节推进**，中文查询与英文同权。
- `sort.rs` —— 自然序（`chapter-10` 在 `chapter-9` 之后）。目录恒在文件前，倒序时也不例外。
- `ops.rs` —— 移动、复制、链接、建目录，以及**只进回收站的删除**。

### 2. 删除只进回收站

`trash` crate 覆盖三平台：Windows `IFileOperation`、macOS `NSFileManager`、Linux freedesktop 规范。

**Linux 实测通过**：文件离开工作区，进入 `~/.local/share/Trash/files/`，`.trashinfo` 记录原路径与删除时间，可原位恢复，中文内容完好。

任何一层都没有永久删除。`bun run verify:trash-only` 扫描 Rust、N-API、TypeScript、IPC 四个面，发现即失败。**已实测该守卫会咬**：注入 `fs::remove_file` 后立刻以退出码 1 失败。

### 3. 高刷屏与超清屏

`apps/desktop/src/main/display.ts`。两件事在构建时不可知：

- **刷新率** —— 动画时长按**帧数**表达而非毫秒。八帧在 60 Hz 是 133 ms，在 165 Hz 是 48 ms，两者读起来是同一个手势。Linux 某些合成器报 0 Hz，降级到 60。
- **像素密度** —— 发丝线是 `1 / scaleFactor` CSS 像素，即一个物理像素。300% 缩放下的 1px 边框是三像素模糊，而这个应用的基线网格全由发丝线构成。

按窗口而非按应用：从笔记本屏拖到桌面屏会重定向。

### 4. 文件浏览器界面

`Files.svelte`，虚拟滚动。**2 万条目在 DOM 里只有 43 行**。

### 5. CI/CD 重写

`.github/workflows/gate.yml`：

- 新增 `native` job，四平台矩阵（linux-x64 / win32-x64 / darwin-arm64 / darwin-x64），各自跑 `cargo fmt --check`、`clippy -D warnings`、`cargo test`，产出平台二进制
- `gate` job 依赖 `native`，下载 Linux 产物后再跑边界测试——否则测试会跳过并报绿
- 新增 `verify:trash-only` 不变量检查
- 新增 `verify-files.ts` 渲染门禁

---

## 二、验证纪律（本轮的新教训）

### 最要紧的一条：只在发版日跑的东西，等于没验证

本轮发布过程中，打包配置连撞三个错误——可执行名非法、desktop 条目键写错、`desktopName` 字段根本不存在。三个都能阻断构建，三个在代码审查里都看不见，因为 **CI 从不跑打包**。

同类问题还有两个：

- `icon.png` 由脚本生成且被 gitignore，而 CI 从不调用那个脚本——CI 产出的安装包会带 Electron 默认图标发出去
- `verify-anchor` / `verify-render` / `verify-seam` 三个验证脚本写了却不在 CI 里；实跑后发现 `verify-anchor` **一直在失败**，而且它报的缺陷是假的（见第三节）

**这三处我在"发布前技术债审查"时都没抓到**，因为我扫的是代码层面（TODO、any、unwrap、死代码、模块规模），没有把「流程本身有没有被执行过」当作一个审查面。

审查清单应当加上一问：**仓库里每一个能失败的东西，是否都有一条路径会真的去跑它？** 写了不跑的检查不只是失效，它还会产出假结论并写进权威文档。

- **几何测量抓不到的，视觉能抓到。** 15 项几何断言全绿时，看一眼截图发现三个真缺陷：修改时间列有表头无数据、大小表头不在其数值上方、首行被表头切掉。已各自补上断言。
- **视觉抓不到的，几何能抓到。** 首屏请求固定 200 行而非按视口计算——截图上完全看不出来，DOM 计数一测即现。
- **两者都要。** 列对齐那个缺陷我猜了三轮才定位，根因是网格轨道宽度不同（203 vs 187）叠加 inline 盒收缩。最后靠直接打印 `getBoundingClientRect` 与 `gridTemplateColumns` 才找到。**遇到几何问题应立即量，不要猜。**
- **`source` 脚本不要覆盖 PATH。** `native-env.sh` 初版直接 `export PATH=...`，把 bun 挤掉了，之后每条命令都报 `bun: command not found`——由启用构建的脚本本身导致的构建失败。已改为追加。

---

## 三、本轮后续完成的三项

### 1. BUG-1 已修：Host 会自己收回 Run

`awaitCompletion` 此前是 `CommandAdapter` 的私有方法，全仓无人调用，派发出去的 Run 永远停在 `dispatched`。

改法：把它提升为 `HarnessAdapter` 的可选能力（文件通道没有进程可等，故为可选），Host 在 `send()` 后跟进每个 Run，命令干净退出即自动 `collect()`。`collect()` 改为幂等，否则自动收取加人工点击会解析两次、memo 追加两次。

同时补上三件相邻的事：`timeoutMs` 真正生效（超时杀进程并置 `failed`）、终态不可逆（已完成的 Run 不被迟到的 cancel 改写）、派发预检失败时整批队列还原（含已启动的部分回滚）。

**5 项 RED 契约转正。**

### 2. L2 Adapter（Claude Code）落地

`packages/agent/src/claude-code.ts`。这是「Token 消耗绝对透明」欠的另一半——此前只兑现了「不撒谎」（一律报 unknown），没兑现「如实回传」。

一手核对了字段名，**与早前记忆不符，已修正**：实际是 `usage`（含 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`），不是 `modelUsage`。

四个数字原样回传，**不做任何加总推导**——harness 没说过的数字就是我们编的。

响应里有 `total_cost_usd`，**读到但刻意丢弃**：SPEC 1.3 禁止显示价格，而代码里存在的数字迟早会到屏幕上。有一条测试专门断言序列化结果里不含 `cost`、`usd` 或那个金额。

argv 用 `--permission-mode dontAsk` 加显式允许表（只给 `Read,Write`），没人看着的子进程绝不能停在权限询问上。会话 ID 跟进，这正是 `personaCarry: first-round` 一直凭约定工作的那个依赖。

**16 项合约测试**，用真实 stub 进程而非 mock。过程中抓到一个真缺陷：Host 自动收取已读过 stdout，调用方再读会拿到 `ReadableStream has already been used`——已改为一次性 promise 回放。

### 3. SPEC Q5：是测量错误，不是布局缺陷

`verify-anchor` 报的 289px 偏移，实测查明是**脚本自己测错了**：夹具从未打开章节，`header.bar` 从不渲染，而 `Progress.svelte` 也用 `.bar` 这个类名——它一直在测进度条与版心的距离，两个不相关的元素。

已把选择器改为 `header.bar`，并让空夹具**失败而非静默报缺陷**。真实是否存在偏移，要等夹具能打开章节后重测。SPEC Q5 已改写为「重新测量」。

教训：一个从未进 CI 的验证脚本，不但会失效，还会产出假的缺陷记录并写进 SPEC。

---

## 四、发布前技术债审查（本轮）

扫过的面与结论：

| 审查面 | 结论 |
|---|---|
| TODO / FIXME / HACK / `@ts-ignore` | 零 |
| `any` 逃逸 | 零（发现一处调试残留，已删） |
| Rust 生产码的 `unwrap` / `panic` | 零 |
| 未被引用的组件 | 零（`STATUS` 记过的坑没重演） |
| 硬编码路径分隔符 | 零 |
| 依赖树 | 6 个直接依赖，均有明确职责 |

修掉的真实债务：

1. **`ipc.ts` 503 行超软上限。** 文件层的 9 个 handler 拆到 `files-ipc.ts`，主文件回落到 384 行。
2. **拆分让不变量守卫失效。** `verify-trash-only` 只扫 `ipc.ts`，通道一搬走就扫不到——**守卫被重构从底下走脱了**。已改为扫描 `src/main/` 全部文件，并加断言「扫到的通道数不为零」。
3. **`link()` 在非 Unix 非 Windows 平台静默成功。** 两个 `#[cfg]` 分支都不命中时，函数什么都没做却返回 `Done`。已补 `#[cfg(not(any(unix, windows)))]` 显式报错。
4. **`bindings.rs` 318 行零测试。** N-API 转换层只被 TS 侧间接覆盖。已补 7 项：`Kind` 字符串映射、`u64::MAX` 转 f64、CJK 名称过界、选项合并保留默认、拒绝码互不碰撞、未知排序键被拒。
5. **三个验证脚本从未进 CI。** `verify-render`、`verify-seam`、`verify-anchor` 写了却不跑。实跑后发现 **`verify-anchor` 一直在失败**（289px 偏移，即 SPEC Q5），而无人知晓。现全部接入，Q5 那条标为 `continue-on-error` 并注明是已知缺陷。
6. **零出网守卫名实不符。** 只扫 `packages/core`，而 CI 步骤名声称覆盖整个进程。已扩到 core / agent / fs / desktop 四层共 59 个文件，并加入 Electron `net.request`、`autoUpdater`、Rust HTTP crate 的检测。
7. **性能基准不在 CI。** 速度是这一层存在的理由，却无守卫。已接入并保留 30 天产物。
8. **`native-env.sh` 覆盖 PATH。** 初版直接 `export PATH=...` 把 bun 挤掉，之后每条命令都 `bun: command not found`——由启用构建的脚本本身导致的构建失败。已改为追加。
9. **`AGENTS.md` 的 setup 缺原生构建步骤。** 新贡献者照做会卡在缺 `.node`。

两个守卫都实测过「确实会咬」：注入 `fs::remove_file` 与注入 `fetch()` 后各自以退出码 1 失败，恢复后通过。

---

## 四、未完成与未验证

### 尚未在真机验证

- **Windows** —— 产物只能由 CI 产出。IME 门禁 `e2e/ime` 在本沙箱无法跑（无 Windows 侧、无显示、无输入法）。**不得伪造该测试结果。**
- **macOS** —— 同上，且 `NSFileManager` 回收站路径未实测。

### 已知边界（SPEC Q8）

工作区所在卷若根目录不可写，freedesktop 规范无法创建 `.Trash-<uid>`，删除失败。**文件保留在原处**，界面会指名说明。这是正确行为——回退到永久删除会破坏这一层存在的理由——但用户在该卷上无法从应用内删除。待产品裁定。

### 上一版遗留、本轮未动

- BUG-1 `awaitCompletion` 无人调用（已有 RED 契约 AG-HOST-001）
- BUG-2 整份 accept 不生效（SPEC Q6，待裁定）
- 缺口-3 L2 Adapter 一个都没有
- 缺口-4 引导式 harness 接入不存在
- 缺口-6 SPEC Q5 章节标题对齐

---

## 四、建议的下一步

1. **你在 Windows 真机上跑一次 harness**，验证文件层与 IME。
2. **裁定 SPEC Q8**（跨卷回收站）与 **Q6**（整份 accept）。
3. **L2 Adapter 从 Claude Code 起**，兑现 token 透明。

---

## 关键文件索引

| 关注点 | 文件 |
|---|---|
| 权威设计基线 | `SPEC.md`（§13 文件层、§14 显示器适配、§12 Open questions） |
| 原生文件层 | `packages/fs/src/{guard,index,search,sort,ops,bindings}.rs` |
| 文件层 TS 封装 | `packages/fs/src/index.ts` |
| 显示器适配 | `apps/desktop/src/main/display.ts`、`src/renderer/display.ts` |
| 文件浏览器 | `apps/desktop/src/renderer/Files.svelte` |
| 渲染验证 | `apps/desktop/scripts/verify-files.ts` |
| 回收站不变量 | `scripts/verify-trash-only.ts` |
| 原生工具链 | `scripts/native-env.sh`（本机无 cc，用 Zig 作链接器；CI 不需要） |
| 性能基准 | `packages/fs/bench/file-layer.bench.ts` |
