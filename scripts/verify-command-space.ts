#!/usr/bin/env bun

/**
 * 命令 id 只有一个空间。
 *
 * **接上哪个功能**：快捷键（`app.zon` 的 `shortcuts`）、系统菜单栏
 * （`app.zon` 的 `menus`）、菜单栏常驻项与右键菜单（`app_main.zig`），
 * 以及它们共同的落点 `core.ts` 的 `commandMsg`。
 *
 * **在全局逻辑中负责什么**：证明这四个入口说的是同一件事。SDK 把菜单选中
 * 与快捷键都送进 `on_command`，所以它们本就共用一个 id 空间——但没有任何
 * 机制拦住「菜单里写了一个 core 不认识的 id」。那种漏写的表现是：菜单项
 * 点下去毫无反应，而两边单看都自洽。
 *
 * 反过来同样要查：`commandMsg` 认识却没有任何入口能触发的 id 是死代码，
 * 它会让「这个功能有没有做」变成一个读代码才能回答的问题。
 *
 * **能复用什么**：新增一个命令只加一行 `commandMsg` 与一处入口声明，
 * 这道门禁不必改。
 *
 * 注入验红三处：给 `app.zon` 的菜单加一个 core 不认识的 command、
 * 从 `commandMsg` 删掉一个仍被菜单引用的分支、
 * 或在 `commandMsg` 里加一个没有任何入口引用的 id。
 */

import { readFileSync } from "node:fs";

const MANIFEST = "apps/native/app.zon";
const CORE = "apps/native/src/core.ts";
const VIEW = "apps/native/src/app_main.zig";

const manifest = readFileSync(MANIFEST, "utf8");
const core = readFileSync(CORE, "utf8");
const view = readFileSync(VIEW, "utf8");

/** `commandMsg` 认识的 id：那个 switch 的每一个 case。 */
function knownCommands(source: string): Set<string> {
  const body = source.match(/export function commandMsg\([\s\S]*?\n\}/u)?.[0];
  if (body === undefined) {
    console.error(`FAIL  verify:command-space: ${CORE} has no commandMsg to read`);
    process.exit(1);
  }
  return new Set(Array.from(body.matchAll(/case "([^"]+)":/gu), (match) => match[1] as string));
}

/**
 * `app.zon` 声明的快捷键 id。
 *
 * 只在 `.shortcuts` 那一段里找：清单顶层的 `.id`（应用 bundle id）也长成
 * `.id = "…"`，全文搜会把它当成一个命令，于是这道门禁会指着一个与命令
 * 无关的字符串报错。
 */
function shortcutIds(source: string): Set<string> {
  const block = source.match(/\.shortcuts = \.\{[\s\S]*?\n {4}\},/u)?.[0] ?? "";
  return new Set(Array.from(block.matchAll(/\.id = "([^"]+)"/gu), (match) => match[1] as string));
}

/** `app.zon` 的菜单项与 Zig 侧常驻项引用的 command。 */
function referencedCommands(zon: string, zig: string): Set<string> {
  const referenced = new Set<string>();
  for (const match of zon.matchAll(/\.command = "([^"]+)"/gu)) referenced.add(match[1] as string);
  for (const match of zig.matchAll(/\.command = "([^"]+)"/gu)) referenced.add(match[1] as string);
  return referenced;
}

const known = knownCommands(core);
const shortcuts = shortcutIds(manifest);
const referenced = referencedCommands(manifest, view);

// 一个入口引用了 core 不认识的 id：点下去毫无反应。
const unknown = [...referenced, ...shortcuts].filter((id) => !known.has(id)).sort();
if (unknown.length > 0) {
  console.error("FAIL  verify:command-space: an entry point names a command core does not know");
  for (const id of unknown) console.error(`      ${id}  add a case to commandMsg in ${CORE}`);
  process.exit(1);
}

// core 认识却没有任何入口能触发的 id：死代码，且让「做没做」读代码才知道。
const reachable = new Set([...referenced, ...shortcuts]);
const orphaned = [...known].filter((id) => !reachable.has(id)).sort();
if (orphaned.length > 0) {
  console.error("FAIL  verify:command-space: commandMsg knows a command nothing can trigger");
  for (const id of orphaned) {
    console.error(`      ${id}  declare it in ${MANIFEST} (shortcuts or menus) or drop the case`);
  }
  process.exit(1);
}

// 菜单里写出的键位必须与快捷键声明一致，否则菜单会教作者一个按不出的组合。
const menuKeys = new Map<string, string>();
for (const item of manifest.matchAll(/\.command = "([^"]+)", \.key = "([^"]+)"/gu)) {
  menuKeys.set(item[1] as string, item[2] as string);
}
const shortcutKeys = new Map<string, string>();
for (const item of manifest.matchAll(/\.id = "([^"]+)", \.key = "([^"]+)"/gu)) {
  shortcutKeys.set(item[1] as string, item[2] as string);
}
const lying = [...menuKeys].filter(([id, key]) => {
  const declared = shortcutKeys.get(id);
  return declared !== undefined && declared !== key;
});
if (lying.length > 0) {
  console.error("FAIL  verify:command-space: a menu prints a key its shortcut does not bind");
  for (const [id, key] of lying) {
    console.error(`      ${id}  menu says ${key}, shortcut binds ${shortcutKeys.get(id)}`);
  }
  process.exit(1);
}

console.log(
  `PASS  verify:command-space  (${known.size} commands, ${shortcuts.size} shortcuts, ${referenced.size} menu references)`,
);
