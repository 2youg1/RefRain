# RefRain 测试总表

> 测试设计稿，2026-07-26。只定义测试，不实现功能，不声称本轮运行结果。
>
> 权威行为来自 `SPEC.md`。若本表与 SPEC 冲突，改本表；若现有测试与 SPEC 冲突，退役现有断言。

## 1. 读法

| 标记 | 含义 |
|---|---|
| **已有** | 本轮开始时已经存在的普通测试。基线为 173 项。 |
| **RED** | 本轮新增或改写为 `test.failing` 的契约。它真实执行当前缺口；实现后先去掉 `.failing`，再进入普通门禁。 |
| **待写** | 已完成行为设计，但还没有可执行夹具。 |
| **待裁定** | 产品语义没有定，不能凭测试替作者决定。 |
| **实机** | 只能在指定操作系统、真实窗口、真实 Harness 或真实 IME 下签字。 |

当前静态清单共有 **203 个逻辑测试**：172 个普通测试，31 个 RED 契约。数字由测试源码索引得出；按用户要求，本轮不运行验证。

测试只落在已经确认的公共边界：

1. `packages/core/src/index.ts` 导出接口；
2. `AgentHost` 与 `HarnessAdapter`；
3. `request.md`、`result.md`、`.refrain/` 与正文文件；
4. preload 暴露的 `window.refrain`；
5. 构建后的渲染页面和真实 Electron 窗口；
6. Windows + Microsoft Pinyin 的真实输入路径。

白盒测试检查系统不变量，不断言私有函数调用次数。黑盒测试不读取 Svelte 状态，只通过文件、公共 API、可访问名称、键盘、窗口和最终正文观察结果。

---

## 2. 现有测试整理

| 区域 | 逻辑测试数 | 已有优势 | 主要缺口 |
|---|---:|---|---|
| `packages/core` | 121 | Artifact 拒绝语料、Review Slice、Decision Batch、Selective Undo、Round Input、Ledger | Text Action 只有 2 项；没有插入语义；缺少属性测试、崩溃注入、Source Backup、跨层事务 |
| `packages/agent` | 71 | L0/L1 基础路径、Grant、Round、Broadcast、Session 投影 | Host 不自动回收；重启不恢复；timeout 空壳；无真实 L2 合约；磁盘原子性不足 |
| `apps/desktop` | 11 | 构建形状、CSP、相对资源、沙箱 | 只有静态 bundle 测试；无 IPC、preload、Svelte 工作流、恢复、真实启动、运行时零出网 |

### 2.1 保留的测试簇

- **Artifact codec**：合法 replacement/comment/CDATA；DTD、外部实体、重复 replacement、未知元素、缺 scope、缺 root、错误 version、root 外文本、过深嵌套。
- **Decision Batch**：逐 Slice 接受、拒绝、改写后接受、未裁决保持原文、竞争 Proposal 拒绝、stale baseline、空批次、纯拒绝入账、交换律。
- **Selective Undo**：补偿行动、后续不相交行动、相交冲突三文本、10,000 次历史、撤销撤销。
- **Agent 编排**：Broadcast 共享 baseline，竞争关系，Grant 的 task/session 边界与无 merge 能力，Round 的关闭与迟到结果。
- **Prompt 组成**：Persona 三档、diff/full/none、稳定前缀、字符数而非 token 数。
- **桌面构建形状**：CJS、preload 路径、`file://` 相对资源、CSP、沙箱、无构建机绝对路径。

### 2.2 应退役或改写的旧断言

- `session.test.ts` 原先要求 compaction 永久冻结 Agent；这与 `SPEC §3.4` 冲突。现改为 RED：compaction 只把 lineage 标成不可验证，Session 仍可由人决定是否继续。
- `smoke.test.ts` 在 `dist/` 不存在时整组 skip，而根 `gate` 不 build；“干净检出全跳过”不能算通过。
- `change-class.test.ts` 只验证典型标点替换，没有验证标点移动和 Emoji ZWJ。原测试不能证明“格式批量接受绝不吞语义”。
- `host.test.ts` 手工调用 `collect()`；它不能证明 L1 completion 会被 Host 接住。
- `command.test.ts` 手工调用 Adapter 私有的 `awaitCompletion()`；它绕过了真正缺失的 Host 回收路径。
- `capture.ts` 里的标题对齐仅 warning；warning 不是门禁。

---

## 3. 已落盘的 RED 契约

### 3.1 Agent Host 与文件协议

- [ ] **AG-HOST-001** 命令退出并写出结果后，Host 不靠 Adapter 专用调用即可完成 Run。
- [ ] **AG-HOST-002** Host 重启后不复用既有 Run ID，不覆盖旧 Task Workspace。
- [ ] **AG-HOST-003** 派发预检失败保留整批 queue，且一个 Run 也不启动。
- [ ] **AG-HOST-004** 命令无法启动时，未派发任务回到 queue。
- [ ] **AG-HOST-005** `timeoutMs` 到期杀进程并把 Run 置为 `failed`。
- [ ] **AG-HOST-006** 已完成 Run 不能被迟到的 cancel 改写为 `cancelled`。
- [ ] **AG-HOST-007** L0 与 L1 遵守同一终态单调性。
- [ ] **AG-HOST-008** replacement 使用伪造 scope 时明确失败，不静默消失。
- [ ] **AG-HOST-009** comment 使用伪造 target 时只丢弃该 comment，不毁掉合法 Proposal。
- [ ] **AG-HOST-010** 非法 UTF-8 在冻结 Proposal 前失败。

### 3.2 Memo、Prompt 与 token 浪费

- [ ] **MEM-001** Agent ID 不能把 memo 写出 `.refrain/memos/`。
- [ ] **MEM-002** memo 文本不能闭合 `<memory>` 或注入新 `<request>`。
- [ ] **MEM-003** 空 memo 等同于没写，不产生标题、时间戳或后续上下文成本。
- [ ] **PROMPT-001** 作者 prompt 不能闭合 `<request>`。
- [ ] **PROMPT-002** 正文不能闭合 `<manuscript>`。
- [ ] **PROMPT-003** 作者 Edit note 不能注入第二个 request。

### 3.3 正文、裁决与审计

- [ ] **EDIT-001** 删除中间块后撤销，恢复原位置而不是追加到文末。
- [ ] **UNDO-001** 多块 Text Action 的冲突报告真正相交块的 before/after/current。
- [ ] **LEDGER-001** 同一 Verdict ID 的重放幂等，不能改写既有审计记录。
- [ ] **BATCH-001** Proposal 级 accept 不能 `ok: true` 却不改正文。
- [ ] **BATCH-002** 未知 Proposal 的 Verdict 拒绝整批。
- [ ] **BATCH-003** 同一 Review Slice 出现相反 Verdict 时拒绝整批，不按数组顺序选赢家。
- [ ] **BATCH-004** `accept-modified` 缺 `finalText` 时拒绝整批。
- [ ] **CLASS-001** 标点跨子句移动判 semantic。
- [ ] **CLASS-002** 改变 Emoji ZWJ 序列判 semantic。

### 3.4 文件、构建与 CI

- [ ] **FILE-001** 名为 `notes.md/` 的目录不使项目加载崩溃。
- [ ] **FILE-002** 新章节标题不能用 `../`、`..\\` 或 NUL 写出项目根。
- [ ] **CI-001** 默认 gate 在干净检出时不能跳过全部桌面测试。
- [ ] **CI-002** Electron 版本或 `bun.lock` 变化会触发 Windows IME gate。
- [ ] **CI-003** 零出网扫描覆盖 `core`、`agent` 和 Electron main，不只扫描 `core`。
- [ ] **SESSION-001** compaction 标记 lineage-unverifiable，但不自动冻结 Session。

---

## 4. Core 白盒与属性测试清单

### 4.1 Text Action 状态模型

使用模型生成器维护一份朴素数组作为 oracle；随机种子写入失败输出，任何失败样本缩减后进入 `fixtures/`。

- [ ] **CORE-TEXT-001** replace/delete 的每个旧 Text Head 字节不变。
- [ ] **CORE-TEXT-002** 一个行动替换连续多块，只保留第一个块 ID，后续块 ID 被消费。
- [ ] **CORE-TEXT-003** 不存在的 block ID 拒绝行动，不产生空 Text Head。
- [ ] **CORE-TEXT-004** 两个 Text Change 重叠时拒绝，不按输入顺序覆盖。
- [ ] **CORE-TEXT-005** 重复 block ID 拒绝。
- [ ] **CORE-TEXT-006** 空 changes 不产生新 Text Head。
- [ ] **CORE-TEXT-007** 10,000 次随机合法行动后始终只有一个 current head；所有历史 head 可读且不变。
- [ ] **CORE-TEXT-008** 除 Text Action 入口外，`core`、`agent`、desktop main 没有第二条正文写路径。
- [ ] **CORE-TEXT-009** 插入首段、中段、末段。
- [ ] **CORE-TEXT-010** 插入的定位表示与稳定 ID 语义。**待裁定：当前 `TextChange` 没有 insertion anchor。**

### 4.2 Edit 与 Selective Undo

- [ ] **CORE-EDIT-001** replace/insert/remove 的 `revertAll(after, editsBetween(before, after)) == before`，固定种子生成 1–500 块。
- [ ] **CORE-EDIT-002** 相同文本的重复段落不会使 LCS 把 Edit 绑到错误 block ID。
- [ ] **CORE-EDIT-003** 首段、末段、连续多段删除均恢复原位置。
- [ ] **CORE-EDIT-004** 段落移动不被误报为任意 replace 链。
- [ ] **CORE-EDIT-005** 撤回一项后，其他 Edit 的文本和 ID 不变。
- [ ] **CORE-UNDO-001** 多块行动中，后续只碰第 2、3、末块时分别报告实际相交块。
- [ ] **CORE-UNDO-002** 多块中某一块被删除时，`blocks-gone` 报告该块。
- [ ] **CORE-UNDO-003** 10,000 次不相交历史重复 30 次，记录 p50/p95，不以单次偶然值签字。
- [ ] **CORE-UNDO-004** Undo 的 Undo 与原行动文本等价，但生成新的 Text Head 和审计 cause。

### 4.3 Review Slice 与 Decision Batch

表驱动遍历 `same | del | ins` × `accept | reject | accept-modified | comment-only | absent`。

- [ ] **CORE-REVIEW-001** CJK 句号、英文缩写、小数、引号、Emoji、CRLF 的 Slice 边界稳定。
- [ ] **CORE-REVIEW-002** 空 before/after 分别生成纯插入和纯删除。
- [ ] **CORE-REVIEW-003** 同一 Proposal 重算 Slice ID 字节一致。
- [ ] **CORE-BATCH-001** 每种 Slice × Verdict 组合的最终文本以手写 oracle 判定。
- [ ] **CORE-BATCH-002** 未知 slice ID 拒绝。
- [ ] **CORE-BATCH-003** Verdict baseline 与 Proposal baseline 不同则拒绝。
- [ ] **CORE-BATCH-004** 同一 Verdict ID 重复只计一次。
- [ ] **CORE-BATCH-005** 100 个互不相交 Proposal 的所有随机排列得到相同正文。
- [ ] **CORE-BATCH-006** 任一 stale/overlap/unknown 使整批零写入、零入账。
- [ ] **CORE-BATCH-007** 文件写成功而 Ledger 失败、Ledger 成功而文件写失败，两种故障都不能留下半个 commit。
- [ ] **CORE-BATCH-008** commit basis 在准备和提交之间变化时整批拒绝。
- [ ] **CORE-BATCH-009** Proposal 级 accept 的最终语义。**待裁定 Q6；共同底线已由 BATCH-001 锁定。**

### 4.4 Artifact parser 与序列化

- [ ] **CORE-ART-001** 合法 grammar 生成器：parse/serialize round trip。
- [ ] **CORE-ART-002** 1–8 层合法深度接受，9 层拒绝；测试边界而不是只测 200 层。
- [ ] **CORE-ART-003** UTF-8 BOM、CRLF、无末尾换行、Emoji、组合字符。
- [ ] **CORE-ART-004** 非法 UTF-8、NUL、截断多字节、截断 CDATA。
- [ ] **CORE-ART-005** 两个 root、尾随 root、XML declaration、namespace、单引号属性、重复属性、未知属性。
- [ ] **CORE-ART-006** DTD/ENTITY 大小写、空白变体、参数实体、外部 file/http URI。
- [ ] **CORE-ART-007** comments 中嵌 replacement、replacement 中嵌 comment、memo 中嵌 tag 全部拒绝或按明确 grammar 解释。
- [ ] **CORE-ART-008** 0 B、1 B、1 MiB、上限−1、上限、上限+1；上限需要写入 SPEC。
- [ ] **CORE-ART-009** 固定种子 mutation fuzz 10,000 例：不崩溃、不联网、不读文件、只返回成功或结构化错误。
- [ ] **CORE-ART-010** 合法 Artifact 的错误信息不包含正文秘密或系统路径。
- [ ] **CORE-REPLY-001** reason、finalText、ref 中的 XML 控制字符不能逃逸。
- [ ] **CORE-REPLY-002** Verdict 顺序在重启、Ledger 重开、相同时间戳下稳定。

### 4.5 Project、Source Backup 与 Ledger

路径表：普通文件、单文件 root、空目录、不存在路径、`.MD`、`.txt`、目录伪装扩展名、symlink、只读文件、Windows 保留名、超长路径、Unicode 规范化碰撞。

- [ ] **CORE-FILE-001** 扫描只收普通文件；子目录、socket、FIFO 不当章节。
- [ ] **CORE-FILE-002** 单文件 root 不收邻居。
- [ ] **CORE-FILE-003** 保存用 temp + fsync + rename；在 write/fsync/rename 三点故障注入后，旧正文或新正文完整存在，绝不截断。
- [ ] **CORE-FILE-004** `.writing` 残留在重启时被识别并报告，不静默覆盖。
- [ ] **CORE-FILE-005** Source Backup 建立后，对 save、merge、revert、rename、crash recovery 前后做 SHA-256，必须一致。
- [ ] **CORE-FILE-006** 所有 Agent/CLI/IPC 路径都没有 Source Backup 写权限。
- [ ] **CORE-FILE-007** 删除 `.refrain/` 不影响正文可读写。
- [ ] **CORE-LEDGER-001** 两个进程并发追加 WAL，不丢 Verdict。
- [ ] **CORE-LEDGER-002** `search("%")` 和 `search("_")` 按字面搜索，不把 LIKE 通配符当用户语义。
- [ ] **CORE-LEDGER-003** SQL 注入字符串只作为参数。
- [ ] **CORE-LEDGER-004** 关闭、重开、进程强杀后顺序和 nullable reason 不变。
- [ ] **CORE-LEDGER-005** 只读磁盘、磁盘满、损坏 DB 给出明确失败，正文不动。

### 4.6 Persona、Carry、Memo、分类器

穷举 `PersonaCarry(3) × round(首轮/后续) × Carry(3) × edits(空/非空) × verdicts(空/非空)`。

- [ ] **CORE-PER-001** 每种组合的 section 顺序、出现次数、字符计数与 hand-written table 一致。
- [ ] **CORE-PER-002** `roundNumber <= 0` 拒绝。
- [ ] **CORE-PER-003** 未声明 PersonaCarry 的默认值在 manifest 和实际 prompt 一致。
- [ ] **CORE-PER-004** compaction 后 first-round Persona 如何处理。**待裁定：应当 full + persona，还是只标警告。**
- [ ] **CORE-MEM-001** collect 同一 Run 两次只追加一次 memo。
- [ ] **CORE-MEM-002** 人手改 memo 后再追加，人工内容保留。
- [ ] **CORE-MEM-003** 0/负预算、1 字符、Emoji 边界不产生半个 surrogate 或半个 XML entity。
- [ ] **CORE-MEM-004** memo 预算约束序列化后的实际字符，不因转义无限膨胀。
- [ ] **CORE-MEM-005** 两个 Agent 并发追加只进入各自文件；同 Agent 并发不交叉截断。
- [ ] **CORE-CLASS-001** 标点替换位置不变可 formatting；跨语法边界移动为 semantic。
- [ ] **CORE-CLASS-002** U+200B 可按格式处理；U+200C/U+200D 与 variation selector 改变为 semantic。
- [ ] **CORE-CLASS-003** 汉字、假名、Hangul、Latin 大小写、数字、数学符号的增删改均 semantic。
- [ ] **CORE-CLASS-004** 固定 corpus 由人逐项签字；分类器升级不得只靠实现自己生成 expected。

---

## 5. Agent Host、Adapter 与 orchestration 测试清单

### 5.1 Run 有限状态模型

状态：`dispatched | completed | failed | cancelled`。事件：dispatch success/fail、completion success/fail、timeout、cancel、valid result、invalid result、late result、workspace deletion、restart。模型测试遍历所有状态 × 事件；每个终态只能保持自身，除非 SPEC 明确允许 late material 作为另一个对象进入。

- [ ] **AG-RUN-001** 所有合法转移与所有非法转移。
- [ ] **AG-RUN-002** terminal state 单调，不被 late cancel/result/timeout 改写。
- [ ] **AG-RUN-003** `collect()` 幂等，Proposal ID 与 memo 均不重复。
- [ ] **AG-RUN-004** result 删除发生在冻结前：显示 missing；发生在冻结后：Proposal 不变。
- [ ] **AG-RUN-005** Task Workspace 外部删除、改名、只读、权限拒绝。
- [ ] **AG-RUN-006** Host 重启恢复 queue、runs、tasks、comments、frozen Proposals；不只恢复目录名。
- [ ] **AG-RUN-007** 100 个 Run 按需读取；列表不一次载入所有 Artifact。

### 5.2 一次点击与批量派发

- [ ] **AG-SEND-001** 空 queue 不创建 Run。
- [ ] **AG-SEND-002** 未注册 Agent、缺 Adapter、无执行文件均在花 token 前报告。
- [ ] **AG-SEND-003** 第 N 个 dispatch 启动失败时，已启动与未启动任务状态均明确；不存在“消失”。
- [ ] **AG-SEND-004** 两次并发 `send()` 不重复派发同一任务。
- [ ] **AG-SEND-005** manifest 与真正派发的 agent/binding/baseline/scopes/prompt 字节一致。
- [ ] **AG-SEND-006** queued 后正文 drift 只标记，不自动 cancel。
- [ ] **AG-SEND-007** 一个任务 40 个不相交 scope 仍是一 Run；多个 Agent broadcast 各一 Run。

### 5.3 Command Adapter 仿真

全部用 argv 可执行脚本，不用 mock subprocess。

- [ ] **AG-CMD-001** request/result 路径含空格、中文、引号、分号、换行。
- [ ] **AG-CMD-002** prompt 含 `$(...)`、反引号、`; rm` 不执行第二条命令。
- [ ] **AG-CMD-003** 退出 0 + 合法结果；退出 0 + 无结果；退出 0 + 非法结果。
- [ ] **AG-CMD-004** 非 0、signal kill、timeout、用户 cancel。
- [ ] **AG-CMD-005** stdout/stderr 各 10 MiB 不造成 pipe deadlock；诊断有大小上限。
- [ ] **AG-CMD-006** timeout 与自然退出同一时刻只产生一个终态。
- [ ] **AG-CMD-007** cancel 与 completion race 重复 1,000 次，状态模型无违例。
- [ ] **AG-CMD-008** `{request}`、`{result}`、`{prompt}` 多次出现均替换；未知 placeholder 明确拒绝。
- [ ] **AG-CMD-009** cwd 不存在、env 缺失、空 template 给出配置错误。

### 5.4 L0 文件通道原子性

- [ ] **AG-L0-001** request 先写 temp、校验、fsync、rename；监听者看不到半文件。
- [ ] **AG-L0-002** result 只在原子 rename 后收取；写到一半不 parse。
- [ ] **AG-L0-003** 原有 result 不被新 attempt 覆盖；每次失败有 attempt ID。
- [ ] **AG-L0-004** request 自足：没有仓库文档时，Agent 仍能按 scope/contract/memo 回复。
- [ ] **AG-L0-005** request 不包含 Context Scope 之外的正文或文件路径。
- [ ] **AG-L0-006** Agent 只获自己的 Task Workspace；跨 Run 写入被拒绝或在 provenance 校验中失败。

### 5.5 Session、Round、Grant、Broadcast

- [ ] **AG-SESSION-001** projected usage 的边界值：limit−1、limit、limit+1；不在浮点舍入处误放行。
- [ ] **AG-SESSION-002** actual/estimated/unknown 三态；unknown 永远不显示 0。
- [ ] **AG-SESSION-003** compaction 只改变 lineage 标签；后续 dispatch 是否继续由人决定。
- [ ] **AG-ROUND-001** close/settle/late result 的全排列；下一轮永不自动创建。
- [ ] **AG-GRANT-001** task、session、agent、run count 四个边界的笛卡尔积。
- [ ] **AG-GRANT-002** revoke 与 spend 并发，只能有一个结果生效。
- [ ] **AG-GRANT-003** 类型和序列化结构中不存在 merge/accept/adjudicate 能力。
- [ ] **AG-BCAST-001** Agent 数为 0、1、2、128；task ID 唯一、baseline 完全相同。
- [ ] **AG-BCAST-002** 某个 Agent 派发失败不改变其他 Agent 的 Runtime Binding 或全局默认。

### 5.6 L2 Adapter 合同套件

每个 Adapter 必须对**真实 Session + 真实 Run**执行同一套测试，不接受录像或 fixture 代替执行证据。

| 合同 | Codex | Claude Code | Pi | Kimi | Hermes |
|---|---|---|---|---|---|
| model/effort 设置并读回，或明确 unlockable | [ ] | [ ] | [ ] | [ ] | [ ] |
| 连续 Run 保持 Runtime Binding | [ ] | [ ] | [ ] | [ ] | [ ] |
| request echo 不算执行证据 | [ ] | [ ] | [ ] | [ ] | [ ] |
| Agent 之间不污染 Session/全局默认 | [ ] | [ ] | [ ] | [ ] | [ ] |
| usage 三态与字段语义正确 | [ ] | [ ] | [ ] | [ ] | [ ] |
| cancel 到达终态 | [ ] | [ ] | [ ] | [ ] | [ ] |
| compaction 标记 lineage-unverifiable | [ ] | [ ] | [ ] | [ ] | [ ] |
| resume/fork 后 usage 去重 | [ ] | [ ] | [ ] | [ ] | [ ] |
| 子 Agent usage 是否包含，按 Harness 文档断言 | [ ] | [ ] | [ ] | [ ] | [ ] |

特别仿真：Pi 的 U+2028/U+2029 JSONL；Codex resume 首条 usage 去重；Claude `modelUsage` 而非 `usage`；Kimi print mode 不冒充 L2；Hermes 同时传 provider/model 并连续消费 SSE 超过五分钟。

---

## 6. Desktop IPC、preload 与黑盒工作流

### 6.1 黑盒夹具

1. 先构建真实 renderer bundle，以 loopback HTTP 提供，`cache-control: no-store`。
2. `addInitScript` 桩掉**整个** `window.refrain`，每次调用写入只追加 call log。
3. 用临时项目目录放真实 Markdown、`.refrain/`、Run Artifact；不用内存字符串代替文件恢复测试。
4. Playwright 只通过 role/name、键盘和正文 `role="textbox"` 操作。
5. 每个测试监听 `pageerror`、console error 和所有 request；除 loopback 自身外任何网络请求立即失败。
6. 真实 Electron 测试另起进程，要求窗口报告 `did-finish-load`；Playwright Chromium 不能替代窗口/IPC/packaging 证据。

### 6.2 普通编辑器在 Agent 离线时完整可用

- [ ] **UI-OFF-001** Agent Host API 全部 reject 时，打开、编辑、保存、搜索、撤销、重做仍可用。
- [ ] **UI-OFF-002** 连续 CJK 输入中没有 Agent、Svelte 或异步保存代码进入 IME path。
- [ ] **UI-OFF-003** Agent 错误只出现在协作面板，不污染正文或保存状态。
- [ ] **UI-OFF-004** 无 project、空 project、单文件、多个 roots 的欢迎页与章节切换。

### 6.3 派发—收取—裁决—回传全链

- [ ] **UI-FLOW-001** 选中文字→写 prompt→选 Agent→加入 queue；未点击 send 前没有 Task Workspace。
- [ ] **UI-FLOW-002** manifest 显示 run count、harness、model、effort、scope、prompt、drift；不显示价格。
- [ ] **UI-FLOW-003** 一次 send 建立所有 Run；二次点击不重复。
- [ ] **UI-FLOW-004** completed Run 自动进入可收取/已收取状态，不要求用户知道 Adapter 方法。
- [ ] **UI-FLOW-005** comment-only 进入 Review，不制造空 Proposal。
- [ ] **UI-FLOW-006** replace/delete/insert 三种 Proposal 在正确位置渲染。
- [ ] **UI-FLOW-007** accept、reject、accept-modified、reason；提交后正文、Ledger、reply 三方一致。
- [ ] **UI-FLOW-008** commit refusal 保留 staged Verdict，不清空用户判断。
- [ ] **UI-FLOW-009** 删除 result 文件后界面显示 missing；冻结后删除不影响 Proposal。
- [ ] **UI-FLOW-010** 两个竞争 Agent 的 Proposal 同时保留；只合并作者选择的一份。

### 6.4 新功能接线

- [ ] **UI-PER-001** Agent 设置页实际渲染 Persona；组件文件存在不算。
- [ ] **UI-PER-002** 四个 preset 可用；编辑 name/brief 后持久化，重启仍在。
- [ ] **UI-PER-003** 甲乙 Agent 来回切换，输入框永不显示或保存错人的 brief。
- [ ] **UI-PER-004** first/every/never 写回对应 Agent；发送前 manifest 显示会发送多少字符。
- [ ] **UI-KEY-001** Alt+J/K 移动 Review Slice；Alt+A/X/E 裁决；Alt+S 勾选；Alt+Enter 提交。
- [ ] **UI-KEY-002** `event.isComposing === true` 时所有裁决快捷键不触发。
- [ ] **UI-KEY-003** 用户改键后立即生效；冲突、保留键、空 chord 明确拒绝。
- [ ] **UI-CLASS-001** formatting 与 semantic 在 Review 中可见；只有 formatting 出现批量接受入口。
- [ ] **UI-CLASS-002** 一个 semantic Slice 使整份 Proposal 失去格式批量接受资格。
- [ ] **UI-CARRY-001** diff/full/none 可选；manifest section/字符数与实际 request 一致。
- [ ] **UI-MEM-001** memo 可查看、编辑、删除；保存的是 Markdown 原文。
- [ ] **UI-MEM-002** compaction/克隆后继 Agent 的第一轮收到已审阅 memo；原 Agent 不被静默改名。
- [ ] **UI-ROLE-001** pending/accepted/refused/agent/source 五色在全部主题保持同一语义。
- [ ] **UI-ROLE-002** pending 是唯一允许饱和的角色；不能再由 `--seal` 同时表示十三件事。
- [ ] **UI-BATCH-001** 勾选多个 Verdict 后一次提交；取消勾选不丢 reason/draft。
- [ ] **UI-BATCH-002** 全选、全不选、跨 Proposal 选择、含竞争 Proposal 的失败反馈。
- [ ] **UI-HARNESS-001** 自动检测本机已安装 Harness；未安装项不显示为 ready。
- [ ] **UI-HARNESS-002** probe success/nonzero/timeout/空输出/版本 stderr；不把存下命令当可用证据。

### 6.5 IPC 与权限

对 preload 公共方法做 schema fuzz；renderer 传入 `unknown` 不能使 main 任意读写或执行。

- [ ] **IPC-001** 每个 preload 方法只调用固定 channel；renderer 拿不到 `ipcRenderer`。
- [ ] **IPC-002** root/title/path/runId/Agent command 的类型、长度、路径归属校验。
- [ ] **IPC-003** renderer 不能通过 title、drop path、resultPath 访问项目外文件。
- [ ] **IPC-004** command 字符串解析不把空格路径拆坏，不经过 shell。
- [ ] **IPC-005** Agent/Persona/Carry/Run/Proposal/queue 持久化，进程重启恢复。
- [ ] **IPC-006** `review:commit` 的 Ledger 与 Markdown 写入是一个可恢复事务。
- [ ] **IPC-007** 两个项目 root 的 Workbench 状态、Agent、Ledger、Proposal 不串线。
- [ ] **IPC-008** 关闭项目释放 SQLite 与子进程；重开不持有旧缓存 head。

---

## 7. 崩溃、恢复、性能与实机门禁

### 7.1 崩溃恢复故障注入

每个点分别 `SIGKILL`：queue 持久化前后、request temp write/fsync/rename、result 收取、Proposal freeze、Ledger record、正文 temp write/fsync/rename、commit 完成标记。

- [ ] **REC-001** 重启后正文是旧版或新版完整文件，没有截断或混合。
- [ ] **REC-002** queue、Run、Result、Proposal、Review staged state、Ledger 恢复到可解释状态。
- [ ] **REC-003** 同一 Run/Proposal/Verdict 不因恢复重复。
- [ ] **REC-004** orphan temp/attempt 文件可见且不自动冒充完成工件。
- [ ] **REC-005** Source Backup 每个故障点前后 hash 不变。

### 7.2 性能

阈值先由基准机实测后写入 `SPEC §10`；测试记录 p50/p95、机器信息和语料 hash，不使用一次运行的偶然毫秒数。

- [ ] **PERF-001** 100k 汉字连续输入延迟与 IME 稳定。
- [ ] **PERF-002** 1 MiB/10 MiB 粘贴。
- [ ] **PERF-003** 100 个 Proposal、1,000 个 Review Slice 的渲染和滚动。
- [ ] **PERF-004** 100-Run 列表按需载入。
- [ ] **PERF-005** 100-site Decision Batch。
- [ ] **PERF-006** 100k Text Changes 的 Ledger/search/index。
- [ ] **PERF-007** 10,000 次历史后 Selective Undo 重复测量。
- [ ] **PERF-008** cold start、warm restore、10/100/1,000 章节。
- [ ] **PERF-009** 1,000 Run 的磁盘增长；Artifact 与 memo 保留策略透明。
- [ ] **PERF-010** 后台 parse/index 时正文输入 p95 不恶化到阈值外。

### 7.3 Windows IME 实机

现有四壳测试保留，并增加 RefRain 真实页面而非通用 ProseMirror 页。

- [ ] **IME-001** 首次点击既有中文正文，候选窗出现，首字不丢。
- [ ] **IME-002** 60 秒机器节奏零 dropped words。
- [ ] **IME-003** 60 秒不规则人类节奏/抖动间隔，补机器固定间隔的盲区。
- [ ] **IME-004** `，。？！` 各 10 次首按提交。
- [ ] **IME-005** 组合期间 Ctrl/Alt 快捷键、右键、切换 Review、自动保存不截断 composition。
- [ ] **IME-006** 长文首段、中段、末段；空段；选区替换；撤销/重做。
- [ ] **IME-007** Electron 版本、Chromium 版本、MS Pinyin 版本写入结果。
- [ ] **IME-008** `apps/desktop/package.json` 或 lockfile 改 Electron 即触发门禁。

### 7.4 真实 Electron 与打包

- [ ] **E2E-001** `did-finish-load`、preload 成功、无 console/page error。
- [ ] **E2E-002** Windows 安装、首次启动、卸载、升级保留项目数据。
- [ ] **E2E-003** file association、拖放文件/目录、中文/超长路径。
- [ ] **E2E-004** 运行时拦截 DNS/TCP/HTTP/WebSocket/Electron `net`/autoUpdater；所有出网尝试计数必须为 0。
- [ ] **E2E-005** 无网络、无 Agent、无字体服务时普通编辑器完整可用。

---

## 8. 仍待产品裁定后才能闭合的测试

- [ ] **Q2** 人与 Agent 能否同时编辑同一文件；决定锁定、drift 或三方合并的黑盒期望。
- [ ] **Q3** 跨 Session 多 Agent 对话编排 UI；决定谁能看见谁的输出。
- [ ] **Q6** Proposal 级 accept 是接受全部，还是必须逐 Slice。已有共同底线测试防止成功空操作。
- [ ] **INSERT** Text Change 的 insertion anchor 与稳定 ID 表示。
- [ ] **CLI** Agent 是否有只读 request/只写 result 的 CLI；无论如何不得存在 merge 命令。
- [ ] **SOURCE** 从既有文件建立项目时，Source Backup 的创建时点、目录结构和恢复入口。
- [ ] **MEMO** 人工编辑后的 memo 是否发送给原 Agent、只发送给后继 Agent，或每次显式勾选。
- [ ] **COMPACTION** compact 后下一轮默认用 full 还是仅警告；选择权必须在发送前可见。

---

## 9. Core 审计补充项

子代理对 `packages/core` 的逐文件审计补出了以下必须进入清单的项目；其中有些是现存缺陷，有些证明现有测试名大于它实际验证的行为。

### 9.1 Artifact 与 provenance

- [ ] **AUD-ART-001** replacement 内嵌未知元素必须拒绝，不能当普通文本接受。
- [ ] **AUD-ART-002** `format` 缺失、`markdown`、未知值按 SPEC 表驱动验证。
- [ ] **AUD-ART-003** `# Before`、`# Request`、baseline、scope、comment target 与 hash 全部验证。
- [ ] **AUD-ART-004** hash 不符只留下 diagnostic attempt，不冻结 Result Artifact。
- [ ] **AUD-ART-005** 先建立 serializer，再做合法 grammar 的 property round trip。
- [ ] **AUD-ART-006** `comments produce no Proposal` 必须通过真正的 Proposal freeze seam 验证，不能只看 parser 数组。

### 9.2 Review、Decision Batch 与 Revision

- [ ] **AUD-REV-001** 全拒绝逐字节恢复 before，包括连续空格、换行和行尾空白。
- [ ] **AUD-REV-002** 拼接非 insert Slice 等于 before；拼接非 delete Slice 等于 after。
- [ ] **AUD-REV-003** Verdict baseline 不同、未知 Slice ID、非法 kind/finalText 组合全部拒绝且不入账。
- [ ] **AUD-REV-004** 真正三方映射允许不相交 drift，拒绝相交 drift；不能把字符串相等冒充映射。
- [ ] **AUD-REV-005** `expectedHeadId` CAS 拒绝 stale commit。
- [ ] **AUD-REV-006** Text Head、Revision、Ledger 同事务；任一写失败，另两者回滚。
- [ ] **AUD-REV-007** 明确建立 `RevisionStore.current/pin/commitTextAction` 公共 seam 后测试“恰有一个 current head”。
- [ ] **AUD-REV-008** 被替换块本身保留 Block ID；不能只测试 untouched block。

### 9.3 Undo、Project 与 Ledger

- [ ] **AUD-UNDO-001** Selective Undo 能恢复删除动作的原 anchor。
- [ ] **AUD-UNDO-002** 即使 `later=[]`，current 已不等于 action.after 仍应冲突。
- [ ] **AUD-UNDO-003** 多 change 冲突报告所有受影响块；空行动不产生补偿 Head。
- [ ] **AUD-FILE-001** symlink 不能把章节保存重定向到 Root 外。
- [ ] **AUD-FILE-002** 不同 Root 的同名章节生成互不相同的 Block ID。
- [ ] **AUD-FILE-003** 单文件 Root 不收邻居；Markdown 空白折叠边界按 SPEC 字节验证。
- [ ] **AUD-LEDGER-001** `forProposal` 只返回目标 Proposal，并保持 decision order。
- [ ] **AUD-LEDGER-002** `%` 与 `_` 按字面 substring 搜索，不当 SQL LIKE 通配符。
- [ ] **AUD-LEDGER-003** Node 子进程执行真实 SQLite round trip；静态 import 正则不能代替运行证明。
- [ ] **AUD-XML-001** Persona name 与 Verdict ref 属性中的引号、`&<>`、控制字符安全编码。

### 9.4 固定语料与性能方法

- [ ] 建立 `packages/core/fixtures/artifacts/{codex,claude,pi,kimi,hermes,l0}/`，保存真实 Artifact。
- [ ] anchor drift、重复段落、多空白、CJK 标点、Emoji、combining marks、长中文章节分别入库。
- [ ] 每个 bug 在修复前先进入 corpus；属性失败保存 seed 和最小样本。
- [ ] `sliceProposal` 与 `editsBetween` 用无公共句子的长章测最坏时间和峰值内存。
- [ ] Selective Undo 分别测 1k/10k/100k history 的增长率，不用单一 `<500ms` 冒充复杂度证明。

### 9.5 SPEC 对齐阻塞项

以下行为先进入 SPEC，测试才有资格成为产品契约：Artifact `<memo>` grammar；formatting 批量接受；Carry 三档与 Prompt section 顺序；Memo 人工修改和复用语义；Selective Undo 的完整模型。

---

## 10. 最终签字清单

测试实现完成后，按以下顺序签字；上一层未过，不用更昂贵的下一层掩盖它。

1. [ ] 所有 RED 去掉 `.failing` 后逐条变绿；没有通过删除断言或改弱 expected。
2. [ ] `core` 状态模型、属性测试、Artifact fuzz 固定种子通过。
3. [ ] Agent Host/L0/L1 使用真实进程和真实文件通过。
4. [ ] 每个 L2 Adapter 的真实 Session 合同通过，并公布实际 tier。
5. [ ] preload/IPC schema 与权限测试通过。
6. [ ] 构建后 renderer 黑盒全流程通过，无 console/page error、无额外网络。
7. [ ] crash recovery 每个故障点通过，Source Backup hash 不变。
8. [ ] 性能基准达到实测后签入 SPEC 的 p95 阈值。
9. [ ] Windows + Microsoft Pinyin + RefRain 真实页面门禁通过。
10. [ ] Windows 安装包在干净机器完成安装—启动—编辑—协作—恢复。
11. [ ] `bun run fmt:check && bun run check && bun test` 通过。
12. [ ] CI 的 build、smoke、运行时零出网、IME gate 都能被对应改动触发，并各自有“门禁确实会咬”的反向测试。

本表完成的标准不是“测试数量多”，而是每条产品承诺都能在其真实边界上失败一次，并在实现后由同一条命令证明恢复。
