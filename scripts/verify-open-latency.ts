#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

// Gate: manuscript open latency on the release profile.
//
// The v0.3.0 target is p95 ≤ 10 ms (one 100 Hz frame) from read to an
// interactive window. That target is asserted by `verify-open-latency
// --target` during release prep; this gate guards against regressions on the
// path there, so its threshold is deliberately looser than the product
// target. A release build on a loaded machine must not flake this gate the
// way wall-clock budgets flake debug builds (see verify-manuscript-scale).
//
// The samples are generated here, not committed: 12 MB of Markdown in 200k
// blocks and 6 MB of Rust in 100k lines exercise the same scale classes as
// the author's real manuscripts without growing the repository.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tmp = join(root, ".tmp");
const mdSample = join(tmp, "gate-open-md.md");
const codeSample = join(tmp, "gate-open-code.rs");
const probe = join(root, "crates", "refrain-app", "examples", "open_probe.rs");
const target = process.argv.includes("--target");
const REGRESSION_BUDGET_MS = 350;
const TARGET_MS = 10;

if (!existsSync(probe)) {
  console.error("FAIL  verify:open-latency: missing probe example");
  process.exit(1);
}

mkdirSync(tmp, { recursive: true });

// 200k Markdown blocks: a heading line followed by a paragraph of CJK prose.
if (!existsSync(mdSample)) {
  const paragraph = "陆沉舟站在窗前，想起营销那件事。数据不会说谎，但人会替数据圆场。\n\n";
  const heading = "# 章节\n\n";
  let out = "";
  for (let i = 0; i < 100_000; i += 1) out += heading + paragraph;
  writeFileSync(mdSample, out);
}
// 100k Rust lines.
if (!existsSync(codeSample)) {
  let out = "";
  for (let i = 0; i < 100_000; i += 1) {
    out += `pub fn function_${i}(value: i32) -> i32 { value + ${i} }\n`;
  }
  writeFileSync(codeSample, out);
}

const build = spawnSync(
  "cargo",
  ["build", "--release", "-p", "refrain-app", "--example", "open_probe"],
  { cwd: root, encoding: "utf8" },
);
if (build.status !== 0) {
  process.stdout.write(build.stdout);
  process.stderr.write(build.stderr);
  console.error("FAIL  verify:open-latency: building the probe");
  process.exit(build.status ?? 1);
}

function measure(sample: string): number {
  const run = spawnSync(join(root, "target", "release", "examples", "open_probe"), [sample], {
    cwd: root,
    encoding: "utf8",
  });
  if (run.status !== 0) {
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    process.exit(run.status ?? 1);
  }
  const line = run.stdout.split("\n").find((l) => l.includes("TOTAL"));
  if (!line) process.exit(2);
  const match = line.match(/TOTAL ([\d.]+) ms p95/);
  if (!match) process.exit(2);
  return Number(match[1]);
}

// NOTE: open_probe measures a double open (raw scan/build plus the full
// DocumentSurface path); the surface is the single authority, so this gate
// tracks its p95 as the product number. Tighten REGRESSION_BUDGET_MS toward
// TARGET_MS as the lazy-id and break-cache work lands.
for (const [label, sample] of [
  ["markdown", mdSample],
  ["code", codeSample],
] as const) {
  const p95 = measure(sample);
  const budget = target ? TARGET_MS : REGRESSION_BUDGET_MS;
  if (p95 > budget) {
    console.error(
      `FAIL  verify:open-latency: ${label} open p95 ${p95}ms exceeds ${budget}ms budget`,
    );
    process.exit(1);
  }
  console.log(`PASS  verify:open-latency  (${label} p95 ${p95}ms, target ${TARGET_MS}ms)`);
}
