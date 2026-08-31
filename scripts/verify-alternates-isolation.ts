#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

import { readFileSync } from "node:fs";

const HOST = "crates/refrain-host/src/host.rs";
const STAGING = "crates/refrain-host/src/staging.rs";

const failures: string[] = [];

const host = readFileSync(HOST, "utf8");
const staging = readFileSync(STAGING, "utf8");

/** 缺席即失败：被检查的对象不在了，这道门禁就什么也没检查。 */
function locate(text: string, needle: string, file: string): number {
  const at = text.indexOf(needle);
  if (at < 0) {
    failures.push(
      `${file} 里找不到 ${needle}：这道门禁失去了检查对象，` +
        `请更新它而不是删掉它——一条找不到目标的检查会静默通过`,
    );
  }
  return at;
}

// Alternates must explicitly wait for nobody; ordered edges must retain their branches.
const launch = locate(host, "HostCommand::LaunchRun", HOST);
if (launch >= 0) {
  const body = host.slice(launch, launch + 3000);
  if (!/ResolvedEdge::Alternates\s*\{[^}]*\}\s*=>\s*None/.test(body)) {
    failures.push(
      `${HOST}：启动路径里 Alternates 没有被显式写成「不等待」。` +
        `落进兜底分支会让新增的边种类继承错误的默认`,
    );
  }
  for (const ordered of ["Follows", "Verifies"]) {
    if (!body.includes(`ResolvedEdge::${ordered}`)) {
      failures.push(
        `${HOST}：启动路径里没有 ${ordered} 的等待分支。` +
          `只有 Alternates 一支时，这条规则就退化成了「谁都不用等」`,
      );
    }
  }
}

// Launch promotes the frozen request without recompiling context.
const promote = locate(staging, "fn promote_request(", STAGING);
if (promote >= 0) {
  const body = staging.slice(promote, promote + 1200);
  // Inspect executable lines so a comment cannot satisfy the rename assertion.
  const executable = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  if (!executable.includes("fs::rename(&staged, &request)")) {
    failures.push(
      `${STAGING}：提升不再是 rename。请求若在启动时被重新编译，` +
        `就有了读到同侪产出的机会，而并列 Run 的独立性正来自「那时它还不存在」`,
    );
  }
}

// Launch must not construct or read another Run's workspace.
const LAUNCH_MUST_NOT_REACH = [
  // 启动时按同侪的 id 取目录：这是把别人的工作区拿到手的唯一形状。
  /run_workspace\s*\(\s*(?:peer|other|alternate|sibling)/,
  // 直接读同侪的产出。
  /(?:peer|other|alternate|sibling)\w*\s*\.\s*join\s*\(\s*"result\.md"/,
];
if (launch >= 0) {
  const body = host.slice(launch, launch + 3000);
  for (const pattern of LAUNCH_MUST_NOT_REACH) {
    if (pattern.test(body)) {
      failures.push(
        `${HOST}：启动路径构造了另一个 Run 的工作区路径（${pattern.source}）：` +
          `并列 Run 之间不该有字节流动`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:alternates-isolation: 并列 Run 的独立性没有被结构保证");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log("PASS  verify:alternates-isolation  (并列 Run 的请求只来自冻结包)");
