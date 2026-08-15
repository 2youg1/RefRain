#!/usr/bin/env bun
/**
 * 发布物的构建必须自己说出目标与 CPU 基线，不许继承跑构建的那台机器。
 *
 * **接上哪个功能**：`.github/workflows/release.yml` 里产出公开发布物的那条
 * `native build`。
 *
 * **在全局逻辑中负责什么**：担保**被下载的那个二进制**为一条声明过的指令集
 * 基线编译。
 *
 * **为什么存在**：v0.3.3 的 Windows 发布物在作者的 Intel i5-1340P 上开机即崩，
 * `0xC000001D`（非法指令），偏移 `0x2203ed` 处是 `f2 0f 78` —— `INSERTQ`，
 * 一条 **AMD SSE4a** 指令。Native SDK 的 `build.zig` 用
 * `b.standardTargetOptions(.{})`，不给 `-Dtarget`／`-Dcpu` 时它解析成**本机**
 * 目标连同**本机 CPU 特性**；GitHub 的 Windows runner 是 AMD，于是 LLVM 放心地
 * 发了一条 Intel 不实现的指令。
 *
 * **仓库里没有任何一条车道能抓到它。** 门禁在一台机器上构建、在同一台机器上
 * 运行，而一台机器永远跑得动自己刚编出来的东西：Linux 绿、Windows 绿、34 条
 * 阻断门禁绿、8/8 journal、连「构建两次比对字节」的可复现性检查都绿——绿在一个
 * 开不了机的二进制上，两次。只有把 CI 编的产物拿到另一种 CPU 上跑才看得见，
 * 而没有一条车道做这件事。
 *
 * 所以判据不是「产物跑得起来」（在编译它的机器上永远跑得起来），而是
 * **「构建命令有没有指名基线」**。指名了，产物就与 runner 的型号无关。
 *
 * **为什么只管 `release.yml`**：只有它产出被下载的东西。给 `gate.yml` 的 Linux
 * 行也指名目标会把 Zig 的查询变成非本机，连带关掉 GTK/X11 需要的系统库搜索，
 * 构建当场失败——那一行编的是一个没有人下载的检查用二进制，它跟着 runner 走
 * 没有后果。`gate.yml` 的 Windows 行仍然自愿用同一个 pin，好让 journal 回放的
 * 正是要发出去的那套指令集，但那是它自己的选择，不是这道门禁强制的。
 *
 * 注入证明这道门禁会咬：把 `release.yml` 的 `-Dcpu=` 删掉，本脚本 exit 1 并
 * 指名那一行。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = join(".github", "workflows", "release.yml");
const failures: string[] = [];
let checked = 0;

const lines = readFileSync(workflow, "utf8").split(/\r?\n/);
for (const [index, line] of lines.entries()) {
  // 注释里提到的命令不是命令。
  if (/^\s*#/.test(line)) continue;
  // `native build` 是唯一产出可执行文件的调用；`native package` 只是把它装箱。
  if (!/\bnative\s+build\b/.test(line)) continue;
  checked += 1;
  const where = `${workflow}:${index + 1}`;
  if (!/-Dtarget=/.test(line)) {
    failures.push(`${where} 缺 -Dtarget=：发布物会跟着 runner 的操作系统与 ABI 走`);
  }
  if (!/-Dcpu=/.test(line)) {
    failures.push(`${where} 缺 -Dcpu=：发布物会带上 runner 型号独有的指令`);
  }
}

if (checked === 0) {
  console.error(
    `FAIL  verify:release-target: ${workflow} 里一条 native build 都没找到 —— 扫错了地方`,
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`FAIL  verify:release-target  (${failures.length} 条发布构建没有指名基线)`);
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(`PASS  verify:release-target  (${checked} 条发布构建，全部指名了目标与 CPU 基线)`);
