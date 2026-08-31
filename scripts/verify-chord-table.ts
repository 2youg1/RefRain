#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * `app.zon` 的快捷键表必须自洽。
 *
 * **接上哪个功能**：键位。作者按下去的每一个和弦都由这张表决定。
 *
 * **在全局逻辑中负责什么**：只判纯读表就能判的两件事——没有两条命令抢同一个
 * 和弦，菜单印出来的键与实际绑定的键是同一个。规则本身住在
 * `e2e/native-input/chords.ts`，那里也是真输入通道读表的地方；这里只报判决。
 *
 * **为什么它值得占一道门禁**：八条 journal 的 `shortcut` 步骤传的是命令 id，SDK
 * 收到直接把命令送进 runtime，键位表根本不在那条路上——表里撞了车、菜单教错了
 * 键，journal 一律全绿。真输入通道能抓住这些，但它要交互式桌面和四十秒；而这两
 * 类缺陷是读表就能判的，不该等到有显示器的机器上才发现。
 *
 * 更深的一层是 `.menus`：每一项自己又写一遍 `.key` 与 `.modifiers`，于是同一条
 * 规则有了两个权威。两边一分岔，菜单就会向作者教一个按下去不算数的键——而
 * `app.zon` 自己的注释说，菜单正是作者学会快捷键的地方。
 *
 * 反证：把 `document.save` 也绑到 `primary+q`，或把菜单里「保存」的键改成 `y`
 * 而 `.shortcuts` 仍是 `s`，这道门禁当场红。
 */

import { join } from "node:path";
import { collidingChords, menuChordMismatches, readChords } from "../e2e/native-input/chords.ts";

const nativeDir = join(process.cwd(), "apps/native");

let chords: readonly ReturnType<typeof readChords>[number][];
try {
  chords = readChords(nativeDir);
} catch (error) {
  console.error(`FAIL  verify:chord-table: ${(error as Error).message}`);
  process.exit(1);
}

const complaints = [...collidingChords(chords), ...menuChordMismatches(nativeDir, chords)];
if (complaints.length > 0) {
  console.error("FAIL  verify:chord-table: app.zon disagrees with itself");
  for (const complaint of complaints) console.error(`      ${complaint}`);
  process.exit(1);
}

console.log(`PASS  verify:chord-table  (${chords.length} chords, no collision, menus agree)`);
