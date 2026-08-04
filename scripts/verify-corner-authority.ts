#!/usr/bin/env bun
/**
 * 圆角的单一权威：`apps/native/src/corners.zig`。
 *
 * 步骤 10 之前守的是「样式表只准引用 corners.ts 导出的变量」；样式表随旧表面
 * 退场之后，同一条规矩换了载体：**半径与超椭圆指数只准出现在 corners.zig 里**，
 * 别处要圆角就调用它的 `Scale`。
 *
 * 为什么仍要一道门禁：注释挡不住有人在视图里直接写一个 `.radius = 8`，
 * 而那正是第 5.2 节禁止的第二份形状权威——它不会报错，只会让某一个方块
 * 悄悄比别处圆一点。
 *
 * 注入证明：在 `app_main.zig` 里写 `.corner_radius = 12`，这道门禁变红。
 */

import { readFileSync } from "node:fs";
import { collect } from "./gate-lib.ts";

const AUTHORITY = "apps/native/src/corners.zig";
/** 裸半径：任何给圆角字段直接写数字的写法。 */
const BARE_RADIUS = /\b(?:corner_radius|radius|corner_smoothing)\s*=\s*[\d.]/;

const files = collect(["apps/native/src/**/*.zig"]).filter((file) => file !== AUTHORITY);
if (files.length === 0) {
  console.error("FAIL  verify:corner-authority: 扫到 0 个 Zig 文件 — 扫描面指错了地方");
  process.exit(1);
}

const strays: string[] = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(\/\/)/.test(line)) return;
      if (BARE_RADIUS.test(line)) strays.push(`${file}:${index + 1} ${line.trim().slice(0, 70)}`);
    });
}

// 权威本身必须还在，且仍然回答那五档。
const authority = readFileSync(AUTHORITY, "utf8");
for (const scale of ["bento", "panel", "card", "control", "pill"]) {
  if (!authority.includes(scale)) {
    console.error(`FAIL  verify:corner-authority: ${AUTHORITY} 少了 ${scale} 一档`);
    process.exit(1);
  }
}

if (strays.length > 0) {
  console.error("FAIL  verify:corner-authority: corners.zig 之外出现了裸半径");
  for (const stray of strays) console.error(`      ✗ ${stray}`);
  process.exit(1);
}

console.log(`PASS  verify:corner-authority  (${files.length} files; five scales in ${AUTHORITY})`);
