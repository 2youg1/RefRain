# Native E2E 会话录制

八条 journal，八个去处各一条，文件名即去处名：`manuscript`（稿子）、`files`
（文件）、`review`（裁决）、`dispatch`（派发）、`mailbox`（信箱）、`connections`
（连接）、`history`（历史）、`settings`（设置）。

- 录：`bun run e2e:record`（全部）或 `bun run e2e:record files review`（挑几条）。
- 放：`bun run e2e:journals`（八条一起，CI 跑的就是这一条）。

哪条 journal 走哪几步、能不能逐帧对指纹，都写在 `scripts/native-journals.ts`
那张表里——它是唯一权威，`Record<JournalName, JournalPlan>` 让「八去处一个
不落」成为编译期约束。

## 录制必须干净退出

`NATIVE_SDK_SESSION_RECORD` 只在应用**正常退出**时封口 journal。被信号杀掉的
进程留不下结束标记，回放判 `JournalTruncated`。

正常出口是 `app.quit` 命令（Ctrl+Q，或系统菜单「文件 → 退出」）。它接 SDK 的
`Cmd.quitApp()`，走最后一扇窗关闭的同一条收尾链。录制器在每条的末尾投递它，
应用没在 15 秒内退出就报错并删掉那条半成品，不留脏文件。

录制器不用定长 sleep：每一步之后轮询 `.zig-cache/native-sdk-automation/snapshot.txt`，
等到界面真的说出那句话为止。部件 id 也是当场按 role+name 查的——界面结构一变，
红在「找不到这个按钮」，而不是点到了别的东西。

## 回放不是真窗

`native automate replay` 走 null 平台：没有窗、没有定时器、没有效果，journal
就是世界（SDK `app_runner/root.zig` 的原话）。真窗在**录制**那一侧。所以 CI 的
那一步很快，也不需要显示器。

## 为什么三条 `--verify`、五条 `--no-verify`

`--verify` 逐帧比对可访问性树的指纹。不打开稿子的三条（`files`、`connections`、
`settings`）全绿：2026-08-15 实测 17 个 checkpoint 全部对上。

打开稿子的五条（`manuscript`、`review`、`dispatch`、`mailbox`、`history`）从
**点开文档行之后的那一帧**开始不匹配，一条也逃不掉。原因是 SDK 的回放把
journal 里的主机结果直接喂给 core（`session_replay.zig`：“host answers must be
fed”），不经过 `apps/native/src/host_bridge.zig` 的 `request` 回调；而正稿住在
host_bridge 的模块变量里，不在 core 模型中。回放因此没有任何一条路把正稿交给
Zig 视图。a11y 对拍确认差异只有正稿 textbox 这一处。

这就是 `docs/ARCHITECTURE.md` 的 M8。修法（把投影搬进 core 模型，视图从模型读）
一落地，改 `native-journals.ts` 那张表的 `tier` 即可，不必去八个地方找
`--no-verify`。

正稿渲染另有门禁守着：`verify:native-theme-pixels` 判的是 PNG 真实像素，
不依赖回放。

## 重录一条的时机

界面结构改了、SDK 升级改了 journal 格式指纹（`JournalFormatMismatch`），或者
某一屏的迁移完成时。改 `scripts/native-journals.ts` 的步骤表，再
`bun run e2e:record <名字>`。
