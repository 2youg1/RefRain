# HANDOFF · RefRain

> 写给下一次会话（可能是另一个 agent，也可能是压缩后的我）。
> 目的只有一个：**读完这份就能接着干，不必重新发现已经发现过的事。**
>
> 状态时点：2026-07-26，`8303c6e`。工作树干净，全部已推送。
> 仓库 `github.com/kaile9/RefRain`，本地 `/workspace/projects/stet/`。

---

## 一、这一轮实际改了什么

按缺陷严重度排，每条都附了当时的证据，因为「为什么这么改」比「改成什么」更难重建。

### 核心闭环三条断流，全部修通

**界面发起的合并此前 100% 失败。** `Dispatch.svelte` 用伪造块 id `${chapter}:sel`，而 core 生成的是 `${chapter}:b${index}`（`project.ts:65`）。`commitDecisionBatch` 按 id 查块，永远查不到，于是每次都以 `stale-baseline` 拒绝。派发与冻结提案能走通，所以这条断流一直看不出来。修法是 `App.svelte` 的 `selectedBlocks()`：选区吸附到它相交的整段，`surfaceEl.children` 的下标就是块序号。

**全部退回也会改动正文。** `sentences()` 为比较做了 `.trim()`，`rebuildReplacement` 用 `.join("")` 重拼，句间空白与段落边界全被吞掉。实测 `"甲。\n\n乙。"` 变成 `"甲。乙。"`，而 `commitDecisionBatch` 返回 `ok: true`，把啃过的文本写回稿子。现在每个切片带 `lead`（它前面的空白），最后一个另带 `trail`——只有 lead 时尾随空白无人携带，那是测试自己抓出来的。

**主进程根本连不上任何 harness。** `make.sh` 用 `--target=node` 打包，Electron 主进程是 Node，而代码里有九处 `Bun.spawn`/`Bun.sleep`。探测恒失败、字体列表恒空、L1/L2 派发一启动就炸。**测试全绿是因为 `bun test` 跑在 Bun 上——跑测试的运行时不是出货的运行时。** 现在统一走 `packages/agent/src/spawn.ts`，并顺带修了三件在 Bun 下也是错的事：输出从启动就抽干（超过 64KB 管道缓冲会永久挂起，而 Claude Code 的 JSON 报告带完整正文）、子进程进自己的进程组（取消 `sh -c "sleep 5"` 从 5000ms 降到 202ms）、二进制不存在时同步抛出（Host 依赖它把任务放回队列）。

### 性能：diff 重写，这是 KL9 的初衷所在

原实现单表 `(n+1)² × 4 bytes`。实测：

| 规模 | 改前 | 改后 |
|---|---|---|
| 一万块改十处 | 836 ms · 381 MB 表格 | **4.1 ms · 4.6 MB** |
| 十万块改千处 | 37 GB —— **超 Int32Array 2GB 上限，构造即抛** | **35.6 ms · 36.4 MB** |

**我先实测了两条常规路线，都不够好**：Hirschberg 修了内存但四万块要 18 秒；Myers O(ND) 在这个规模也要 4 秒且保存每步 trace。真正的解法是**先按未改动的长段（≥8 句）切分**，利用「稿子绝大部分没变」这个事实把巨表拆成许多小表。四项性能测试在 `packages/core/test/diff-scale.test.ts`，预算设得比实测松几倍——回到二次行为是三个数量级的差距，不是几个百分点。

### 主题：八套，昼夜分道

**KL9 明确裁定：暗色不是日间的反面，各自独立，日间不做对应夜间。** 现为日间五套（濤・霞・枯・林・瓷）＋夜间三套（墨・幽・時雨），共八态。

`docs/theme-tokens.ts` 是生成器：一套主题四个锚点（纸・墨・印・副强调），其余 28 个变量推导，实测 APCA 写进 CSS 注释。**任何一项不达标脚本拒绝写出**，已用注入法验证。

推导规则里有五条是踩出来的，都已成为脚本检查项，**不要在没读过理由的情况下改动**：

1. **侧栏由纸面亮度推导，不是墨色。** 按墨色推导在日间碰巧正确；夜间的墨是浅色，于是得到浅侧栏配浅文字，Lc 0.0，完全不可读。
2. **夜间侧栏跟随纸的色相。** 取墨的色相让幽得到藏青侧栏配森绿纸面，两种不相干的材质。侧栏是房间的一部分，不是光。
3. **版心恒为最亮的一层。** 原式 `paper + up*0.014` 在日间 `up=-1`，五套日间的版心全部比纸暗 0.014——最该读作纸的那层是窗口里最暗的面，看着像浅色卡片压在白纸上。
4. **升更亮、沉更暗，两种时段一致。** 随时段翻转的写法让夜间的凹陷面看着像个洞。
5. **三层明度跨度 ≥ 0.060。** 此前 0.054，三层实际靠发丝线区分。眼睛在暗部分辨的差异远小于亮部。

**回避纯白纯黑及擦边色**（KL9 要求，已成硬检查）：任一通道 <16 或 >242、L <0.14 或 >0.972 即拒绝。旧检查只覆盖五个变量且margin太窄，`#fcfaf6` 和 `#0c0700` 都能过——它们在真实面板上与纯值无从分辨。

对比度用 **APCA**（W3C Silver 草案）而非 WCAG 2：后者在深色底上把浅字算得比实际好读，而这里有三套主题整个活在那种条件下。

### SPEC Q6 / Q8 已裁定并实现

**Q6** —— 不做「整份 accept」，改做**全选**：一键把每个切片各 stage 成一条 accept，用户仍要点合并。账本落二十条独立裁决而非一条「整份接受」，粒度正是 Verdict Ledger 的意义。`rebuildReplacement` 的语义不动。

**Q8** —— 无回收站的卷上，界面说明后提供**「移到系统回收站」**（主目录卷）。实现时 `verify:trash-only` 拒绝了我第一版（含 `fs::remove_dir_all`），**守卫是对的**，逼出来的 `rename` 方案更好：失败时文件自动回到原处。另外发现 `trash_all` 只回传人类语句、不含错误码，那个提示根本不可能触发——已改为 `code` 与 `error` 分列两字段（这也是评审 #44）。

### 四档窗口质感

一个意象的四种距离——雨天从屋里往外看，中间隔着什么：

| 档 | 名 | alpha | blur | 意境 |
|---|---|---|---|---|
| 0 | 晴 sei | 1.00 | 0px | 不看外面。默认 |
| 1 | 靄 moya | 0.92 | 6px | 隔着水汽——亚克力 |
| 2 | 傘 kasa | 0.80 | 16px | 透明伞下 |
| 3 | 硝子 garasu | 0.64 | 30px | 隔窗观雨——液态玻璃 |

### 其余

类型门禁此前不覆盖 `apps/desktop`，单独跑 tsc 有 14 个错误，含 `ipc.ts` 用了六个从未导入的符号——五条 IPC 通道在打包版里一碰就 ReferenceError。已接进 `bun run check`。

关于页写死 0.1.2 达一个版本之久，现从 `package.json` 注入；加了四个 GitHub 链接，走白名单 IPC 通道（开放任意 URL 等于让渲染进程代理出网，无出网不变量就只剩字面）。八个无处理器的 verdict 快捷键已移除——它们会抢先吃掉用户自定义然后什么也不做。

多 root 时任意章节都被写进 `roots[0]`（内容进错项目却显示已保存）、未保存时切章节直接覆盖 DOM、`save()` 自我竞态——三条都修了，都会弄丢或错放稿子。

---

## 二、给下一次会话的操作须知

```bash
cd /workspace/projects/stet
export PATH="/hermes/home/.bun/bin:$PATH"
bun run gate          # fmt:check → check → test，272 项
bun docs/theme-tokens.ts   # 改了主题锚点后必须重跑
```

原生层需要 `. scripts/native-env.sh`（本机无 cc，用 Zig 作链接器；CI 不需要）。

四道不变量守卫：`verify:gate` / `verify:no-network` / `verify:trash-only` / `verify:gates-run`。最后一条会检查「每个守卫都有路径调用它」——它抓住过我新加的守卫只在 `make.sh` 里跑、CI 日志看不见。

**沙箱里的三个坑**：`vite build` 会被终端误判为长驻进程，用 `./make.sh`；heredoc 在 `git commit` 里会卡住，把提交信息写进文件再 `-F`；`patch` 的匹配要注意 biome 会把 `0.190` 格式化成 `0.19`，我为此浪费了四轮。

---

## 三、待办

### 等 KL9 反馈

- **八套主题**是否通过（最新截图在 `docs/preview-shots/theme-*.png`，预览页 `docs/theme-preview.html`）。霞已按「冰蓝不要太灰、樱色偏白带渐变」改过两轮；幽已按「不喜欢金色」整套去金重做。
- **默认中文字体**：KL9 说「字体按照你的推荐来」，即 **ChillDINGothic**（SIL OFL 1.1，原文 `can be bundled, embedded, redistributed and/or sold with any software`，7MB/字重，有可变字重，约 21k 汉字含繁体，上游 `Warren2060/ChillDIN-ChillDINGothic`，注意许可证文件名是小写无扩展名的 `license`）。**尚未落地到代码。**

### 字体授权，已自证完成（不是转述）

| 字体 | 协议 | 结论 |
|---|---|---|
| **ChillDINGothic** | SIL OFL 1.1 | ✅ 可打包可子集化，**推荐作默认** |
| 致一黑體_傳承形 | IPA Font License 1.0 | ⚠️ 可打包但**不得改名不得改动**，23MB/字重，故不能子集化 |
| Mizuki-Gothic | IPA Font License 1.0 | ⚠️ 4.22MB 最小，但**上游已停维护**，作者自述「不建議用於繁體字」 |
| **MiSans** | 小米专有 | 🚫 §2(3) 禁止「进一步分发字体软件或其任何副本」，授权**可撤销** |
| **OPPO Sans 4.0** | OPPO 专有 | 🚫 「不向他方提供其他下载渠道」——GitHub Release 正是 |
| HarmonyOS Sans | 华为专有 | ✅ 但可撤销。原文明确许可 `embed, bundle, redistribute`，是三家国产里唯一放行的 |

网上大量文章写 MiSans/OPPO「免费开源可商用」，那指的是**用字体做设计**免费，不是**再分发字体文件**。这个区别是本次审计的价值所在。

### 性能（KL9 说这是初衷，优先级最高）

- [ ] **同步 N-API 阻塞主进程**（评审 #26）：`bindings.rs` 的 scan/sort/search 全同步跑在 main，`files-ipc.ts:96` 每次 move/copy/trash 后还追加全量重扫。十万条目一次操作冻结数百毫秒。改 `AsyncTask` + 增量索引。
- [ ] **长文档渲染**：目标十万块。`content-visibility: auto` + `contain-intrinsic-size`，但要注意它与 IME 组合和浏览器查找的交互——这两条我还没验证。
- [ ] 性能调研子代理**两次超时零交付**，不要再派它，自己在仓库里实测更快。

### 已知缺陷，未修

- [ ] **持久化整体缺失**（#25）：agent 名册／队列／运行记录／未合并提案全在内存 Map，**关窗即失**。`agents.json` 文档有代码无。
- [ ] **失败原因到不了界面**（#28）：`command.ts` 与 `claude-code.ts` 先置 `failed` 再 throw，`host.watch` 的 catch 只在 `state==="dispatched"` 时记录，原因被跳过；`failureFor` 无 IPC 通道。
- [ ] **collect 无结果时 run 永远悬挂**（#29）：`host.ts:238` throw 但不置状态。
- [ ] **Guard 只覆盖文件浏览器通道**（#20）：`memo.ts:30` 与 `writeChapter`（`project.ts:112`）走裸 `node:fs`，正文写路径在守卫圈外。AGENTS.md 不变量 4 的实际覆盖面小于其表述。
- [ ] **外部修改无检测**（#49）：heads 缓存 + `writeChapter` 无 mtime 比对，用户在别的编辑器改了文件，RefRain 保存时静默覆盖。
- [ ] **session/grant/contextScope 未接线**（#24）：`canDispatch`/`freeze` 仅测试引用，`AgentHost.send()` 无容量检查，`contextScope` 在 `Dispatch.svelte` 硬编码 `[]`。SPEC 2.2 的 Context Scope 目前只是类型字段。
- [ ] **LCS 已修，但 `edits.ts:37` 的同类问题还在**（#34）：选择性撤销那条路径仍是 O(n×m)。
- [ ] **`reserved-keys.ts` 整个文件是死代码**（#33）：`inspectChord` 全仓零调用，用户可以把命令绑成裸键 `A`。

### 其他

- [ ] **西文字体推荐**：标题体 + 两款有特色的正文体。子代理超时零交付，未重做。
- [ ] **编辑器能力与 Agent 架构评估报告**：KL9 要资深编辑视角与 Harness 设计师视角。
- [ ] **macOS**：KL9 说本地无硬件，以后再做。
- [ ] **Windows 中文输入法门禁**：`e2e/ime` 在本沙箱跑不了（无 Windows 侧、无显示、无输入法），GitHub 托管 runner 实测也跑不通（装 MS Pinyin 约半小时后仍无法在非交互桌面启动验收壳）。**必须 KL9 在真机上跑，不得伪造该结果。**

---

## 四、两条方法论，值得带走

**跑测试的运行时不是出货的运行时。** `Bun.spawn` 事件、`bun:sqlite` 事件、`electron` 模块在 `bun test` 下是 CommonJS 存根事件——同一个错误犯了三次。第三次我加了 smoke 测试断言「被测试加载的模块不得在顶层引用 Electron 运行时 API」。

**视觉判断与几何测量互相纠错，两者都不可单独采信。** 视觉模型报告「只有最后一个链接有下划线」，实测四个的 `text-decoration-line` 全是 `underline`，真实问题是 1px/45% 的下划线被汉字笔画吞没。反过来，版心比纸暗 0.014 这个系统性缺陷是视觉检视发现的，八套色值表上看不出来。**APCA 全绿不等于设计成立**——它检验不到色相关系与明度分档。
