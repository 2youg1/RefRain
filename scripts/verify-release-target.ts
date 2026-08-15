#!/usr/bin/env bun
/**
 * 每一条 CI 里的 `native build` 都必须自己说出目标与 CPU 基线。
 *
 * **接上哪个功能**：`.github/workflows/` 里所有产出可执行文件的构建步骤。
 *
 * **在全局逻辑中负责什么**：担保发布物为一条**声明过的**指令集基线编译，
 * 而不是为跑构建的那台机器编译。
 *
 * **为什么存在**：v0.3.3 的 Windows 发布物在作者的 Intel i5-1340P 上开机即崩，
 * `0xC000001D`（非法指令），偏移 `0x2203ed` 处是 `f2 0f 78` —— `INSERTQ`，
 * 一条 **AMD SSE4a** 指令。Native SDK 的 `build.zig` 用
 * `b.standardTargetOptions(.{})`，不给 `-Dtarget` 时它解析成**本机**目标连同
 * **本机 CPU 特性**；GitHub 的 Windows runner 是 AMD，于是 LLVM 放心地发了一条
 * Intel 不实现的指令。本机构建、CI 构建、门禁全绿——因为每一台机器都跑得动
 * 自己编出来的东西。**只有把 CI 编的那个二进制拿到另一种 CPU 上运行才看得见。**
 *
 * 所以判据不是「跑得起来」（在编译它的机器上永远跑得起来），而是
 * **「构建命令有没有指名基线」**。指名了，产物就与 runner 的型号无关。
 *
 * 注入证明这道门禁会咬：把 `release.yml` 的 `-Dcpu=` 删掉，本脚本 exit 1 并
 * 指名那一行。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflows = join(".github", "workflows");
const failures: string[] = [];
let checked = 0;

for (const name of readdirSync(workflows)) {
  if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
  const text = readFileSync(join(workflows, name), "utf8");
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    // 注释里提到的命令不是命令：`gate.yml` 有一段解释为什么 `native build` 曾经
    // 在那里死过，把它当成一条构建会报一个永远清不掉的红。
    if (/^\s*#/.test(line)) continue;
    // `native build` 是唯一产出可执行文件的调用；`native test` 与 `native check`
    // 不产出发布物，跟着 runner 走没有后果。
    if (!/\bnative\s+build\b/.test(line)) continue;
    checked += 1;
    const where = `${workflows}/${name}:${index + 1}`;
    if (!/-Dtarget=/.test(line)) {
      failures.push(`${where} 缺 -Dtarget=：产物会跟着 runner 的操作系统与 CPU 走`);
    }
    if (!/-Dcpu=/.test(line)) {
      failures.push(`${where} 缺 -Dcpu=：产物会带上 runner 型号独有的指令`);
    }
  }
}

if (checked === 0) {
  console.error(
    "FAIL  verify:release-target: 工作流里一条 `native build` 都没找到 —— 扫的地方错了",
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`FAIL  verify:release-target  (${failures.length} 条构建没有指名基线)`);
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(`PASS  verify:release-target  (${checked} 条 native build，全部指名了目标与 CPU 基线)`);
