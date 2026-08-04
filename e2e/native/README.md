# Native E2E 会话录制

三条 journal 由 `scripts/record-journal.sh` 录制，`bun run e2e:app` /
`e2e:review` / `e2e:dispatch` 回放它们。

## 录制必须干净退出

`native automate record` 只在应用**正常退出**时封口 journal。被信号杀掉的
进程留不下结束标记，回放判 `JournalTruncated`。

正常出口是 `app.quit` 命令（⌘Q / Ctrl+Q，或系统菜单「文件 → 退出」）。
它接 SDK 的 `Cmd.quitApp()`，走最后一扇窗关闭的同一条收尾链。
`record-journal.sh` 在每次录制末尾投递它，并在应用仍存活时报错退出。

重录一条：

```sh
DISPLAY=:100 bash scripts/record-journal.sh "$PWD/e2e/native/writing-slice.journal" \
  "widget-action document <textbox-id> set_text 一段新写的正稿" \
  "shortcut document.save"
```

widget id 从 `bun x native automate snapshot` 的 `accessibility.txt` 里读，
它随界面结构变化，不要硬记。

## 为什么是 `--no-verify`

回放本身是校验过的：三条都报 `session replay verified: deterministic`，
事件逐条重放，退出码 0。

`--verify` 额外比对每一帧的可访问性树哈希，当前差在**一个节点**上：正稿
textbox。原因是 SDK 的回放把 journal 里的主机结果直接喂给 core
（`session_replay.zig`：“host answers must be fed”），不经过
`apps/native/src/host_bridge.zig` 的 `request` 回调；而正稿住在 host_bridge
的模块变量里，不在 core 模型中。回放因此没有任何一条路把正稿交给 Zig 视图。

a11y 对拍确认差异只有这一处，其余 19 个节点逐字节相同。

正稿渲染另有门禁守着：`verify:native-theme-pixels` 判的是 PNG 真实像素，
不依赖回放。

**修法**（v0.2.6 首项）：把投影搬进 core 模型，视图从模型读，回放即天然
一致。模型已持有多个 `Uint8Array`，不是新概念；要测的是每帧
11.5 KiB 过 core 的开销。修完把这三条改回 `--verify`。
