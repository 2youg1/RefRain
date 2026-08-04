#!/usr/bin/env bun

/**
 * 跨界请求的形状由 Rust 说了算。
 *
 * **接上哪个功能**：Zig 的 `project_request.zig` 与 Rust 的 `ProjectInput`。
 *
 * **在全局逻辑中负责什么**：接线之后这两处各持一份 JSON 写法，而 serde 的
 * 口径并不统一——`ProjectInput` 的字段是 camelCase，`HostCommand` 的字段
 * 保持 Rust 拼写（`run_id`），`Disclosure` 是 kebab-case。按同一种规律猜，
 * 三处里有两处会得到一条被 Rust 具名拒绝的请求，而作者看到的只是「没反应」。
 *
 * 这道门禁做两件事：跑 Rust 侧的期望清单（`examples/wire_shapes.rs`，
 * 它逐条比对 serde 的真实输出），再确认 Zig 的字面量里没有出现那几个
 * 看起来更规律、实际会被拒绝的拼写。
 *
 * **能复用什么**：新增一个入口只需在 Rust 那份清单里加一行。
 *
 * 注入验红：把 `project_request.zig` 的 `run_id` 改成 `runId`，
 * 或把期望清单里的 `outline-only` 改成 `outlineOnly`。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WRITER = "apps/native/src/project_request.zig";

// Rust 侧逐条比对 serde 的真实输出。它是这道门禁的主体。
const probe = spawnSync("cargo", ["run", "-q", "-p", "refrain-app", "--example", "wire_shapes"], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  console.error("FAIL  verify:wire-shapes: the Rust shape probe refused the current writer");
  const detail = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  for (const line of detail.split("\n").slice(-12)) console.error(`      ${line}`);
  process.exit(1);
}

// Zig 侧不得出现那几个「看起来更规律」的拼写。它们不会让编译失败，
// 只会让请求被 Rust 拒绝——正是最难归因的一类失败。
//
// `runId` 只在 `hostCommand` 那一段是错的（`HostCommand` 的字段保持 Rust
// 拼写），在 `collectRun` 里它是对的（`ProjectInput` 的字段是 camelCase）。
// 所以这一条按段落查，不按全文查——一刀切会把正确的写法也判红，而那会
// 逼下一个人放宽门禁。
const writer = readFileSync(WRITER, "utf8");
const hostCommandBlock = writer.match(/pub fn hostRunCommand[\s\S]*?\n\}/u)?.[0] ?? "";
const scoped = [
  [hostCommandBlock, '"runId"', "HostCommand keeps Rust field spelling: run_id"],
  [writer, '"outlineOnly"', "Disclosure is kebab-case: outline-only"],
  [writer, '"acceptModified"', "VerdictKindName is kebab-case: accept-modified"],
] as const;
const found = scoped.filter(([haystack, needle]) => haystack.includes(needle));
if (found.length > 0) {
  console.error("FAIL  verify:wire-shapes: the Zig writer uses a spelling serde will refuse");
  for (const [, needle, why] of found) console.error(`      ${needle} in ${WRITER}  ${why}`);
  process.exit(1);
}

console.log(`PASS  verify:wire-shapes  (${(probe.stdout ?? "").trim().split("(")[1] ?? "checked"}`);
