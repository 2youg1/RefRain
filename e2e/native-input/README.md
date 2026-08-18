# 真输入通道

只用 OS 级输入驱动已发布的二进制：`keybd_event` 与 `mouse_event`，坐标从可访问性树
报的 `bounds` 算出来，和弦从 `apps/native/app.zon` 读出来。判据里有一半是像素。

- 跑：`bun run e2e:input`（Windows；要有交互式桌面，不要输入法）
- 只查键位表：`bun run e2e:input:chords`（纯读表，不起窗口，秒级）

## 它补的是哪一块

`e2e/native` 的八条 journal 走 automation 通道，三个动词都不经过输入层：

| journal 的步骤 | 实际发生的事 | 于是测不出 |
|---|---|---|
| `click` → `widget-click <id>` | 按 id 点部件 | 命中测试、坐标映射、被别的面遮住 |
| `type` → `widget-action set_text` | 直接置换整段文本 | 按键序列、光标与选区、撤销粒度 |
| `shortcut` → `shortcut <command-id>` | 把命令直接送进 runtime | **整张键位表** |

回放侧更弱：`native automate replay` 走 null 平台，没有窗、没有定时器、没有效果，
而 CI 跑的正是回放。所以那八条测的是 core 状态机与可访问性树，输入层与绘制层
一寸都不覆盖。

`e2e/ime` 确实是真输入，但它要 `zh-Hans-CN` 装在机器上——于是「真点击、真按键、
真像素」这件事一直被输入法的安装与否挡着。这条通道只按 ASCII 与和弦，不碰输入法。

## 走一遍什么

1. 真点击「打开一个项目文件夹」→ 树里长出文档行
2. 真点击文档行 → 正稿框上台
3. 真点击落进正稿 → `focused=true`
4. 真按键打字 `Refrain`
5. 真和弦 `document.save`（Ctrl+S）→ **磁盘上的文件必须含有那几个字**
6. 真和弦 `document.undo`
7. 真和弦 `theme.next`（Ctrl+Shift+T）→ **纸色必须真的变**
8. 真和弦 `go.2`
9. 真和弦 `app.quit`（Ctrl+Q）→ 进程必须自己退干净

## 画面证据为什么不是哈希

`e2e/ime` 的清单记两张截图的 SHA-256 并要求它们不同。一张全黑的图哈希同样稳定，
两张不同的全黑图哈希同样不同——哈希证明不了屏幕上画过任何东西。这里解像素
（`scripts/png-pixels.ts`，与主题门禁同一个解码器）：纸面得是纸色，正稿区得有墨，
换主题之后那一片纸色得离原来的足够远。

取样区是可访问性树报的正稿矩形，不是猜的比例。猜比例的那一版把区域放在了第一行字
的下方，测出 0% 的墨并报「什么都没画」——而字就在那里。

## 它真的会红

三类，都验过：

- **键位表内部冲突**：把 `document.save` 也绑到 `primary+q`，`e2e:input:chords`
  当场红（`primary|q is claimed by both document.save and app.quit`），不必起窗口。
- **菜单与键位表分歧**：`.menus` 每一项自己又写一遍 `.key`，是同一条规则的第二个
  权威。把菜单的「保存」改成 `y` 而 `.shortcuts` 仍是 `s`，纯读表即红。
- **`app.zon` 与已发布二进制漂移**：把 `.shortcuts` 的 `document.save` 改成 `y`
  但不重建，通道按 `y`、应用听 `s`，于是「磁盘上的文件不含打进去的字」两条红。
  同样的漂移下，journal 的 `shortcut document.save` 步骤全绿——那正是这条通道
  存在的理由。

## 与 journal 的分工

journal 覆盖八个去处的状态机与可访问性树，快、无需显示器、CI 每次都跑。这条通道
覆盖输入层与绘制层，要真桌面，跑得慢。两边问的不是同一个问题，谁也不替代谁。
