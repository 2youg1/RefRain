#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * 把 `app.zon` 的快捷键表读成可以真按下去的键。
 *
 * **接上哪个功能**：真输入通道要按的每一个和弦。
 *
 * **在全局逻辑中负责什么**：只做「命令 id → 键与修饰符 → 平台虚拟键码」这一次
 * 翻译。键位本身一个字都不在这里——`app.zon` 是唯一权威，这里读它。
 *
 * **为什么这件事值得存在**：八条 journal 的 `shortcut` 步骤传的是命令 id，SDK
 * 收到就直接把命令送进 runtime，键位表根本不在那条路上。于是 `app.zon` 写错一个
 * 键、两条命令抢同一个和弦、某个修饰符在 Windows 上不成立——journal 全绿。这个
 * 模块存在的意义就是让「表里写的那个和弦」与「按下去真的会发生的事」对上。
 *
 * 直接跑它会把整张表按 JSON 印到 stdout，给 PowerShell 驱动读：
 *
 *     bun e2e/native-input/chords.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Chord {
  readonly id: string;
  readonly key: string;
  readonly modifiers: readonly string[];
  /** Windows 虚拟键码；修饰符按下的顺序就是数组顺序。 */
  readonly windows: {
    readonly modifierCodes: readonly number[];
    readonly keyCode: number;
  };
}

/** `primary` 在 Windows 上是 Ctrl，在 macOS 上是 ⌘——这条只答 Windows。 */
const WINDOWS_MODIFIER: Readonly<Record<string, number>> = {
  primary: 0x11,
  shift: 0x10,
  alt: 0x12,
};

/** 非字母数字键的虚拟键码。表里出现过的每一个都必须在这里有名字。 */
const WINDOWS_NAMED_KEY: Readonly<Record<string, number>> = {
  escape: 0x1b,
  enter: 0x0d,
  space: 0x20,
  tab: 0x09,
  backspace: 0x08,
  "[": 0xdb,
  "]": 0xdd,
};

function windowsKeyCode(key: string): number {
  const named = WINDOWS_NAMED_KEY[key.toLowerCase()];
  if (named !== undefined) return named;
  if (key.length === 1) {
    const code = key.toUpperCase().codePointAt(0) ?? 0;
    // A–Z 与 0–9 的虚拟键码就是它们的 ASCII 值,这是 Win32 的定义而不是巧合。
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)) return code;
  }
  throw new Error(`app.zon names key "${key}", which this lane has no virtual-key code for`);
}

/**
 * 解 `app.zon` 的 `.shortcuts` 段。
 *
 * 手写的小解析器而不是通用 ZON 解析：要读的只有一段固定形状的列表，而引一个
 * 解析器进来，它对 ZON 的理解就成了第二个可能与 Zig 编译器不一致的地方。形状
 * 一变这里就抛错，而不是安静地少读几条。
 */
export function readChords(nativeDir: string): readonly Chord[] {
  const source = readFileSync(join(nativeDir, "app.zon"), "utf8");
  const section = /\.shortcuts\s*=\s*\.\{([\s\S]*?)\n {4}\},/u.exec(source);
  if (!section) throw new Error("app.zon has no .shortcuts block in the expected shape");
  const entry =
    /\.\{\s*\.id\s*=\s*"([^"]+)"\s*,\s*\.key\s*=\s*"([^"]+)"\s*(?:,\s*\.modifiers\s*=\s*\.\{([^}]*)\})?\s*,?\s*\}/gu;
  const chords: Chord[] = [];
  for (const found of (section[1] ?? "").matchAll(entry)) {
    const id = found[1] ?? "";
    const key = found[2] ?? "";
    const modifiers = [...(found[3] ?? "").matchAll(/"([a-z]+)"/gu)].map((m) => m[1] ?? "");
    const modifierCodes = modifiers.map((name) => {
      const code = WINDOWS_MODIFIER[name];
      if (code === undefined) throw new Error(`app.zon names modifier "${name}", unknown here`);
      return code;
    });
    chords.push({ id, key, modifiers, windows: { modifierCodes, keyCode: windowsKeyCode(key) } });
  }
  if (chords.length === 0) throw new Error("app.zon declares no shortcut this lane can press");
  return chords;
}

/**
 * 同一个和弦落在两条命令上,按下去只有一条会赢——而哪一条赢是没有人写下来的。
 * 这是纯读表就能判的事,不必起窗口,所以它在这里而不是在断言里。
 */
export function collidingChords(chords: readonly Chord[]): readonly string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const chord of chords) {
    const shape = `${[...chord.modifiers].sort().join("+")}|${chord.key.toLowerCase()}`;
    const first = seen.get(shape);
    if (first === undefined) seen.set(shape, chord.id);
    else collisions.push(`${shape} is claimed by both ${first} and ${chord.id}`);
  }
  return collisions;
}

/**
 * 菜单里写的键位与快捷键表写的必须是同一个。
 *
 * `app.zon` 的 `.menus` 每一项自己又写一遍 `.key` 与 `.modifiers`，于是同一条
 * 规则有了两个权威。两边一旦分岔，菜单会向作者教一个按下去不算数的键——
 * 而菜单正是作者学习快捷键的地方（`app.zon` 自己的注释这么写）。这是纯读表
 * 就能判的事，不必起窗口。
 */
export function menuChordMismatches(
  nativeDir: string,
  chords: readonly Chord[],
): readonly string[] {
  const source = readFileSync(join(nativeDir, "app.zon"), "utf8");
  const menus = /\.menus\s*=\s*\.\{([\s\S]*)\n {4}\},/u.exec(source);
  if (!menus) return [];
  const item =
    /\.command\s*=\s*"([^"]+)"\s*,\s*\.key\s*=\s*"([^"]+)"\s*(?:,\s*\.modifiers\s*=\s*\.\{([^}]*)\})?/gu;
  const declared = new Map(chords.map((chord) => [chord.id, chord]));
  const mismatches: string[] = [];
  for (const found of (menus[1] ?? "").matchAll(item)) {
    const id = found[1] ?? "";
    const key = found[2] ?? "";
    const modifiers = [...(found[3] ?? "").matchAll(/"([a-z]+)"/gu)].map((m) => m[1] ?? "");
    const chord = declared.get(id);
    if (!chord) {
      mismatches.push(`the menu offers ${id}, which .shortcuts never binds to a key`);
      continue;
    }
    const menuShape = `${[...modifiers].sort().join("+")}|${key.toLowerCase()}`;
    const chordShape = `${[...chord.modifiers].sort().join("+")}|${chord.key.toLowerCase()}`;
    if (menuShape !== chordShape) {
      mismatches.push(`${id}: the menu prints ${menuShape} but .shortcuts binds ${chordShape}`);
    }
  }
  return mismatches;
}

if (import.meta.main) {
  const nativeDir = join(import.meta.dir, "../../apps/native");
  const chords = readChords(nativeDir);
  const complaints = [...collidingChords(chords), ...menuChordMismatches(nativeDir, chords)];
  if (complaints.length > 0) {
    console.error(`FAIL  app.zon disagrees with itself:\n  ${complaints.join("\n  ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify(chords, null, 2));
}
