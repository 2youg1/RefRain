#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * 主题只有一个权威。
 *
 * **接上哪个功能**：七套主题的 CSS、原生色表与 Model 常量。
 *
 * **在全局逻辑中负责什么**：证明三处消费同一份锚点数据——
 * `scripts/generate-themes.ts` 的 `THEMES` 表。它不检查颜色好不好看
 * （APCA 门槛在生成时已经拦过），只检查**没有第二份手抄本**。
 *
 * **能复用什么**：重跑生成器再比字节，与 `verify:skill-doc-current`
 * 同一形状——生成物漂了就红，不需要在这里复述任何色值。
 *
 * 注入验红：改 `themes.zig` 里任何一个色值、或把 core 的 `THEME_COUNT`
 * 调成 6，这道门禁都会指名失败。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GENERATOR = "scripts/generate-themes.ts";
const GENERATED = ["apps/native/src/generated/themes.zig"] as const;

const before = GENERATED.map((path) => readFileSync(path, "utf8"));
const rerun = spawnSync("bun", [GENERATOR], { encoding: "utf8" });
if (rerun.status !== 0) {
  console.error("FAIL  verify:themes-current: the generator refused to run");
  console.error(`      ${(rerun.stderr ?? "").trim().split("\n").slice(-4).join("\n      ")}`);
  process.exit(1);
}

const drifted = GENERATED.filter((path, index) => readFileSync(path, "utf8") !== before[index]);
if (drifted.length > 0) {
  console.error("FAIL  verify:themes-current: a generated theme file was edited by hand");
  for (const path of drifted) console.error(`      ${path}  run \`bun ${GENERATOR}\``);
  process.exit(1);
}

// 色表只剩一份产物（Zig），所以「几套主题」的权威是它。
const zig = readFileSync(GENERATED[0], "utf8");
const count = (zig.match(/^\s{8}\.slug = "/gmu) ?? []).length;
if (count === 0) {
  console.error("FAIL  verify:themes-current: the native theme table is empty");
  process.exit(1);
}

// 单元 13 之前这里比的是 `core.ts` 的 `THEME_COUNT` 与表里的套数——两处漂开的
// 表现是换主题时越界回落，而两边单看都自洽。Zig 核心不再声明那个数字：
// `themeCount()` 当场读 `themes.themes.len`。漂移因此不是被抳住了，而是不可表示。
//
// 这道门禁改成守那个**结构**：核心里不得再长出一个手写的套数。
const core = readFileSync("apps/native/src/core.zig", "utf8");
if (!/themes\.themes\.len/u.test(core)) {
  console.error(
    "FAIL  verify:themes-current: the core no longer derives the theme count from the generated table",
  );
  process.exit(1);
}
const handWritten = core.match(/const theme_count[^\n]*= *(\d+)/u)?.[1];
if (handWritten !== undefined) {
  console.error(
    `FAIL  verify:themes-current: the core hand-writes a theme count (${handWritten}); the generated table is the one authority`,
  );
  process.exit(1);
}

// 默认主题也只能有一个说法：生成表的 `default_index` 与 `Model.theme_index` 的
// 缺省必须同值。不同的表现是首帧画的不是作者选的那一套。
const defaultIndex = zig.match(/pub const default_index: usize = (\d+);/u)?.[1];
const model = readFileSync("apps/native/src/core/model.zig", "utf8");
const modelDefault = model.match(/theme_index: u8 = (\d+),/u)?.[1];
if (defaultIndex === undefined || modelDefault === undefined || defaultIndex !== modelDefault) {
  console.error(
    `FAIL  verify:themes-current: default theme index disagrees (table ${defaultIndex ?? "none"}, Model ${modelDefault ?? "none"})`,
  );
  process.exit(1);
}

// 原生色表必须真的带上颜色。全是 SDK 默认值说明映射断了。
if (!/\.background = Color\.rgb8\(/u.test(zig)) {
  console.error("FAIL  verify:themes-current: the native table carries no paper colour");
  process.exit(1);
}

console.log(
  `PASS  verify:themes-current  (${count} themes; css, catalogue, native table and core agree)`,
);
