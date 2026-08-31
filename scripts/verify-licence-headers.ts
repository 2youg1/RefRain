#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * Every distributed file states its licence, or states why it cannot.
 *
 * MPL 2.0 attaches to a file through the notice in Exhibit A (Sec. 1.4), so a
 * source file without it is not covered by the licence the repository claims
 * in `Cargo.toml`, `package.json`, and `README.md`. The whole tree was written
 * without the notice and swept once; a sweep alone fixes the files that exist
 * and nothing about the next one. This gate is the half that lasts.
 *
 * It reads `git ls-files`, not a glob, because the question is about what
 * recipients receive. A file outside the index is not distributed and owes
 * nothing; a file inside it owes either a notice or a recorded exemption.
 *
 * Unknown file families fail. Adding `.kt` or `.py` to the tree stops the gate
 * until `licence-notice.ts` rules on it, which is the point: the failure that
 * produced this gate was a decision nobody was ever asked to make.
 *
 * `--write` attaches every missing notice in place. It is how the first sweep
 * ran, and how a later one runs after a large import.
 *
 * Injection proof that this gate bites:
 *   1. Delete the three notice lines from any tracked `.rs` file → red, naming it.
 *   2. Reflow the notice onto two lines → red; Sec. 1.4 wants Exhibit A verbatim.
 *   3. Commit a file with an unruled extension → red, naming the extension.
 *   4. Empty the tracked set → red; a gate over no files proves nothing.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  classify,
  EXEMPT_REASONS,
  type ExemptReason,
  hasNotice,
  withNotice,
} from "./licence-notice.ts";

const write = process.argv.includes("--write");

const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (tracked.status !== 0 || tracked.stdout === null) {
  const reason = tracked.error?.message ?? tracked.stderr?.trim() ?? "unknown";
  console.error(`FAIL  verify:licence-headers: git ls-files failed: ${reason}`);
  process.exit(1);
}

const paths = tracked.stdout.split("\0").filter((path) => path !== "");
if (paths.length === 0) {
  console.error(
    "FAIL  verify:licence-headers: git tracks no files — the scan is looking in the wrong place",
  );
  process.exit(1);
}

const missing: string[] = [];
const unknown: string[] = [];
const attached: string[] = [];
const exempt = new Map<ExemptReason, number>();
let carrying = 0;

for (const path of paths) {
  const decision = classify(path);
  if (decision.kind === "unknown") {
    unknown.push(path);
    continue;
  }
  if (decision.kind === "exempt") {
    exempt.set(decision.reason, (exempt.get(decision.reason) ?? 0) + 1);
    continue;
  }
  carrying += 1;
  const text = readFileSync(path, "utf8");
  if (hasNotice(text, decision.syntax)) continue;
  if (write) {
    writeFileSync(path, withNotice(text, decision.syntax), "utf8");
    attached.push(path);
    continue;
  }
  missing.push(path);
}

if (unknown.length > 0) {
  console.error("FAIL  verify:licence-headers: file families nobody has ruled on");
  for (const path of unknown) {
    console.error(`      ${path}: add it to CARRIES or EXEMPT in scripts/licence-notice.ts`);
  }
  process.exit(1);
}

if (missing.length > 0) {
  console.error(
    `FAIL  verify:licence-headers: ${missing.length} distributed file(s) claim no licence`,
  );
  for (const path of missing) console.error(`      ${path}`);
  console.error("      run: bun scripts/verify-licence-headers.ts --write");
  process.exit(1);
}

const coverage = [...exempt.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([reason, count]) => `      ${count} ${reason}: ${EXEMPT_REASONS[reason]}`)
  .join("\n");

if (write && attached.length > 0) {
  console.log(`WROTE verify:licence-headers: attached the notice to ${attached.length} file(s)`);
  for (const path of attached) console.log(`      ${path}`);
}

console.log(`PASS  verify:licence-headers  (${carrying} files carry Exhibit A)`);
console.log(coverage);
