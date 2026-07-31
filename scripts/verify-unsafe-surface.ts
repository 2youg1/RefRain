#!/usr/bin/env bun
import { readFileSync } from "node:fs";
/**
 * unsafe 的范围是一个决定，不是一个现状。
 *
 * 产品代码里现在只有一处 `unsafe`：`display.rs` 向 Win32 问显示器刷新率。
 * 那里没有安全封装可用——`GetMonitorInfoW` 与 `EnumDisplaySettingsW` 是裸
 * FFI，调用方必须自己保证结构体的 size 字段已经填好。**清除它做不到，只能
 * 把它挪到别处**，而挪走会让它离 `#[cfg(target_os)]` 守卫和 Linux 回退更远。
 * 所以这道门禁守的不是「零 unsafe」，是**它不扩散**。
 *
 * 两件事各由一半负责：
 *
 * 1. 纯逻辑 crate 由 `#![forbid(unsafe_code)]` 挡住，编译器执行，比门禁强。
 *    这里断言那句 `forbid` **还在**——它是一行，删掉不会有任何测试变红。
 * 2. 装配层（`apps/desktop/src-tauri`）不能 forbid，因为它含那处 FFI。
 *    这里逐行扫描它，只接受登记在册的那一处。
 *
 * 扫描面用通配符而非枚举：新建的 crate 会自动落进检查，而枚举清单要人记得
 * 去加，没人记得。
 *
 * 四条注入各对一条分支：
 *   - 删掉任一 crate 的 `#![forbid(unsafe_code)]` → 红（分支 1）
 *   - 在装配层新增一处 `unsafe {` → 红（分支 2）
 *   - 把登记的例外改名或搬走 → 红（分支 3：过期额度）
 *   - 把扫描面指向不存在的目录 → 红（分支 4：扫描结果为空）
 */

import { collect } from "./gate-lib.ts";

/** 必须由编译器禁止 unsafe 的 crate。通配符跟随代码，新 crate 自动入列。 */
const PURE_CRATE_ROOTS = ["crates/*/src/lib.rs"];

/** 装配层：含唯一一处正当的 FFI，故只能逐行扫描。 */
const ASSEMBLY_SOURCES = ["apps/desktop/src-tauri/src/**/*.rs"];

/**
 * 登记在册的 unsafe。
 *
 * 键是文件，值是那个文件里允许的行数。**下降也要登记**：数目变少时这里报错
 * 要求下调，否则表就成了一个永不收紧的地板，而下一个人可以在额度内自由新增。
 */
const ALLOWED: Readonly<Record<string, number>> = {
  // Win32 没有安全封装：两个 API 都要求调用方先填好结构体的 cbSize/dmSize，
  // 这个约束表达不进类型系统。已收敛在单个函数内，有 cfg 守卫与非 Windows 回退。
  "apps/desktop/src-tauri/src/display.rs": 1,
};

const failures: string[] = [];

// —— 分支 1：纯 crate 的 forbid 还在不在 ——
const libFiles = collect(PURE_CRATE_ROOTS);
if (libFiles.length === 0) {
  console.error("FAIL  verify:unsafe-surface: 没有扫到任何 crate 根模块 — 扫描面指错了地方");
  process.exit(1);
}
for (const file of libFiles) {
  const text = readFileSync(file, "utf8");
  // 装配层不在这个清单里（它是 apps/ 下的 bin crate），故此处一律要求 forbid。
  if (!/^#!\[forbid\(unsafe_code\)\]$/m.test(text)) {
    failures.push(`${file}: 缺少 #![forbid(unsafe_code)]，unsafe 可以悄悄进来`);
  }
}

// —— 分支 2/3：装配层逐行扫，只认登记过的 ——
const assemblyFiles = collect(ASSEMBLY_SOURCES);
if (assemblyFiles.length === 0) {
  console.error("FAIL  verify:unsafe-surface: 没有扫到装配层源码 — 扫描面指错了地方");
  process.exit(1);
}

const counted: Record<string, number> = {};
for (const file of assemblyFiles) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, index) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    // `unsafe {` 与 `unsafe fn`/`unsafe impl` 都算。`unsafe_font_names` 这类
    // 标识符不算——要求 unsafe 后面是空白或块，否则同名变量会被误判。
    if (/\bunsafe\s*(\{|fn\b|impl\b|trait\b)/.test(line)) {
      counted[file] = (counted[file] ?? 0) + 1;
      if (ALLOWED[file] === undefined) {
        failures.push(`${file}:${index + 1}: 未登记的 unsafe — ${line.trim()}`);
      }
    }
  });
}

for (const [file, allowance] of Object.entries(ALLOWED)) {
  const found = counted[file] ?? 0;
  if (found > allowance) {
    failures.push(`${file}: 现有 ${found} 处 unsafe，登记额度为 ${allowance}`);
  } else if (found < allowance) {
    // 收紧了就必须留下 diff，否则过期额度会给下一次回退留好位置。
    failures.push(`${file}: 现只剩 ${found} 处 unsafe，请把登记额度从 ${allowance} 下调`);
  }
  if (found === 0 && !assemblyFiles.includes(file)) {
    failures.push(`ALLOWED 登记了 ${file}，但该文件已不存在（改名会把额度送给下一个占名者）`);
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:unsafe-surface");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

const total = Object.values(counted).reduce((sum, one) => sum + one, 0);
console.log(
  `PASS  verify:unsafe-surface  (${libFiles.length} crates forbid unsafe; ${total} registered unsafe site(s) across ${assemblyFiles.length} assembly files)`,
);
process.exit(0);
