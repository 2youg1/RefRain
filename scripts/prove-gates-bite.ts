#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * Proves each gate bites (SPEC 11.6).
 *
 * A gate that cannot fail is worse than no gate: it reads as coverage. So each
 * one is run against a repository carrying the exact defect it claims to catch,
 * and is required to exit non-zero and name the offence.
 *
 * Two failure modes this script defends against, both learned the hard way:
 *
 * 1. **The injection does not land.** An anchor that does not match rewrites
 *    nothing, the gate correctly passes, and the run reads as a dud gate. So
 *    every injection asserts its own anchor was found before the gate runs.
 * 2. **The restore does not restore.** A partial cleanup leaves the tree dirty
 *    and the next gate fails for an unrelated reason. Restore is in `finally`,
 *    and the byte content is compared against what was read.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Injection {
  readonly gate: string;
  /** How to run it, when it is not `bun scripts/<gate>.ts` — a Haskell gate. */
  readonly command?: readonly string[];
  readonly file: string;
  /** Absent for a created file; present for an edit to an existing one. */
  readonly anchor?: string;
  readonly replacement?: string;
  /** For a created file. */
  readonly content?: string;
  /** A fragment the failure output must contain, proving it named the offence. */
  readonly expect: string;
}

const INJECTIONS: readonly Injection[] = [
  {
    // 菜单里写一个 core 不认识的命令：点下去毫无反应，而两边单看都自洽。
    // 这正是四个入口共用一个 id 空间时唯一会静默的失败。
    gate: "verify:command-space",
    file: "apps/native/app.zon",
    anchor: '.{ .id = "theme.next", .key = "t"',
    replacement: '.{ .id = "theme.previous", .key = "t"',
    expect: "theme.previous",
  },
  {
    // Zig 把 `run_id` 写成 `runId`：编译得过，请求却被 serde 拒绝，界面上
    // 只是「按钮没反应」。这是接线之后最难归因的一类失败。
    gate: "verify:wire-shapes",
    file: "apps/native/src/project_request.zig",
    anchor: 'if (!writer.key("run_id")',
    replacement: 'if (!writer.key("runId")',
    expect: "runId",
  },
  // These two used to bite `apps/native/src/roster.ts`. The lane switch deleted
  // it, and every hand-written TypeScript under `apps/native/src/` with it — the
  // only files left there are generated, and both gates exempt the generated
  // bridge on purpose. So the bite creates the file it needs instead of editing
  // one: what is being proved is that the gate still names a network call and a
  // hand-written bridge call **anywhere in that tree**, which is exactly the
  // shape a new file would have.
  {
    gate: "verify:no-network",
    file: "apps/native/src/injected_network_probe.ts",
    content: 'await fetch("https://example.com/telemetry");\n',
    expect: "injected_network_probe.ts",
  },
  {
    gate: "verify:bridge",
    file: "apps/native/src/injected_bridge_probe.ts",
    content: 'const raw = invoke("health", {});\n',
    expect: "injected_bridge_probe.ts",
  },
  {
    gate: "verify:core-purity",
    file: "crates/refrain-core/src/health.rs",
    anchor: "use serde::{Deserialize, Serialize};",
    replacement: "use serde::{Deserialize, Serialize};\nuse std::fs;",
    expect: "health.rs",
  },
  {
    gate: "verify:trash-only",
    file: "crates/refrain-store/src/schema.rs",
    anchor: "pub fn open_in_memory() -> rusqlite::Result<Connection> {",
    replacement:
      "pub fn scrub(path: &str) {\n    std::fs::remove_file(path).ok();\n}\n\npub fn open_in_memory() -> rusqlite::Result<Connection> {",
    expect: "schema.rs",
  },
  {
    gate: "verify:write-path",
    file: "crates/refrain-app/src/document.rs",
    anchor: "pub(crate) fn persist_in_entry(",
    // 这个注入的命令必须真的调用写入函数。先前注入的是一个**空**函数
    // （`fn save_chapter(_text: String) {}`），门禁照样通过——它没有说谎：
    // 一个什么都不做的命令确实没有写任何字节。缺陷在注入样本，不在门禁。
    // 注入要造出的那个世界是「未授权的路径写入手稿」，空函数造不出它。
    replacement:
      "pub(crate) fn scrub_chapter(entry: &mut ProjectEntry) {\n    let _ = entry.store.commit(&DocumentCommit::default());\n}\n\npub(crate) fn persist_in_entry(",
    expect: "scrub_chapter",
  },
  {
    gate: "verify:roundtrip",
    file: "tests/corpora/ideographic-indent.md",
    anchor: "　　全角空格缩进的段落，中文写作常用。",
    replacement: "　　全角空格缩进的段落，中文写作常用。 ",
    expect: "ideographic-indent.md",
  },
  {
    gate: "verify:manuscript-scale",
    file: "crates/refrain-core/src/manuscript/align.rs",
    anchor: "const ANCHOR: usize = 8;",
    replacement: "const ANCHOR: usize = usize::MAX;",
    expect: "review.rs",
  },
  {
    gate: "verify:native-ime",
    file: "patches/native-sdk-cli.patch",
    anchor: "const bool queried = ImmGetCandidateWindow(imc, 0, &observed) != FALSE;",
    replacement: "const bool queried = syntheticCandidate(imc, &observed) != FALSE;",
    expect: "native-sdk-cli.patch",
  },
  {
    gate: "verify:gates-run",
    file: "scripts/verify-injected-orphan.ts",
    content: "// A gate nothing invokes.\nconsole.log('PASS');\n",
    expect: "verify-injected-orphan.ts",
  },
  {
    // 401 行：刚好越过预算一行。它未入索引，因而同时证明两件事——
    // 预算对新文件生效，且它在提交之前就生效。
    gate: "verify:line-budget",
    command: ["runghc", "-igates", "gates/LineBudget.hs"],
    file: "crates/refrain-core/src/injected_line_budget_probe.rs",
    content: `${"// one line of a module nobody can hold in their head\n".repeat(401)}`,
    expect: "injected_line_budget_probe.rs",
  },
  {
    // 一个无人声明的补丁文件。它看上去是一项生效的修改，实际上 bun
    // 从未读到它——这正是 #38 合入后那个补丁所处的状态。
    gate: "verify:patched-dependency",
    command: ["runghc", "-igates", "gates/PatchedDependency.hs"],
    file: "patches/injected-orphan.patch",
    content: "diff --git a/nothing b/nothing\n",
    expect: "injected-orphan.patch",
  },
];

const commandFor = (injection: Injection): readonly string[] =>
  injection.command ?? ["bun", `scripts/${injection.gate.replace("verify:", "verify-")}.ts`];
const injectionPaths = [...new Set(INJECTIONS.map((injection) => injection.file))];
const statusBefore = spawnSync("git", ["status", "--porcelain", "--", ...injectionPaths], {
  encoding: "utf8",
}).stdout;

let proved = 0;
const problems: string[] = [];

for (const injection of INJECTIONS) {
  const created = injection.content !== undefined;
  const original = created ? null : readFileSync(injection.file, "utf8");

  try {
    if (created) {
      // Created injections may name a path whose directory does not exist in
      // a fresh checkout (legacy/ is not tracked). Make the parent, or the
      // injection fails before any gate could bite it.
      const parent = dirname(injection.file);
      if (parent !== ".") mkdirSync(parent, { recursive: true });
      writeFileSync(injection.file, injection.content ?? "");
    } else {
      if (injection.anchor === undefined || injection.replacement === undefined) {
        throw new Error(`${injection.gate}: an edit needs both an anchor and a replacement`);
      }
      // The injection must land. A silent no-op would make a working gate look
      // like a dud, which is the reverse misreading and just as expensive.
      if (!original?.includes(injection.anchor)) {
        throw new Error(`${injection.gate}: ANCHOR MISSING in ${injection.file}`);
      }
      writeFileSync(injection.file, original.replace(injection.anchor, injection.replacement));
    }

    const [command, ...args] = commandFor(injection);
    if (command === undefined) throw new Error(`${injection.gate}: no command`);
    const result = spawnSync(command, args, { encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;

    if (result.status === 0) {
      problems.push(`${injection.gate}: passed with its defect injected — the gate does not bite`);
    } else if (!output.includes(injection.expect)) {
      problems.push(
        `${injection.gate}: failed but never named "${injection.expect}" — the diagnostic is useless`,
      );
    } else {
      console.log(`BITES  ${injection.gate}  (exit ${result.status}, named ${injection.expect})`);
      proved += 1;
    }
  } finally {
    if (created) {
      rmSync(injection.file, { force: true });
    } else if (original !== null) {
      writeFileSync(injection.file, original);
    }
  }
}

// Everything must be back the way it was, or the next run measures a different
// repository than the one this one claims to have tested.
for (const injection of INJECTIONS) {
  if (injection.content !== undefined && existsSync(injection.file)) {
    problems.push(`${injection.gate}: injected file ${injection.file} was not removed`);
  }
}

const statusAfter = spawnSync("git", ["status", "--porcelain", "--", ...injectionPaths], {
  encoding: "utf8",
}).stdout;
if (statusAfter !== statusBefore) {
  problems.push(`injection paths changed state:
before:
${statusBefore}after:
${statusAfter}`);
}
console.log(`\nproved ${proved}/${INJECTIONS.length} gates bite`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  process.exit(1);
}
