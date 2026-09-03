#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

import { readFileSync } from "node:fs";
/**
 * Everything that can fail must have a path that runs it.
 *
 * The v0.1.x release found a verification script that had been failing
 * unnoticed for weeks, and an icon CI never generated — the same shape both
 * times: a check existed, and nothing ran it. A check nobody runs is worse
 * than a missing one, because it reads as coverage. One of them did more than
 * go stale: it manufactured a defect that was written into SPEC as an open
 * question and stayed there.
 *
 * So the two lists get compared: the gates on disk, and the gates something
 * invokes. Both directions matter. A gate not invoked is dead. A gate invoked
 * but absent is a stage that silently does nothing.
 *
 * Both gate languages are scanned. `scripts/verify-*.ts` is the TypeScript
 * layer this repository started with; `gates/*.hs` is the black-box layer it
 * writes new checks in. A gate that nothing runs is dead in either language,
 * and a scan that knew only one of them would go quiet exactly as the tree
 * moved to the other.
 *
 * Injection proof that this gate bites: add `scripts/verify-nothing.ts` without
 * wiring it into gate.ts or package.json and this exits 1 naming it. The same
 * holds for an unwired `gates/Nothing.hs`.
 */

import { Glob } from "bun";

const onDisk: string[] = [];
for await (const file of new Glob("verify-*.ts").scan({ cwd: "scripts" })) {
  const name = file.split(/[/\\]/).pop() ?? file;
  // `verify-*.test.ts` is a counterfactual test for a gate, not a gate. `bun
  // test` runs it; `gate.ts` never names it. Scanning it as a gate reports a
  // permanent orphan that no wiring can clear — the fix would be to register a
  // test file as a gate stage, which then runs twice and reports twice.
  if (name.endsWith(".test.ts")) continue;
  onDisk.push(name);
}

// A gate is a program. `gates/Gate.hs` holds what every gate shares — UTF-8
// reading and the report shape — and declares no `main`, so nothing runs it
// directly and nothing should. Asking for the module header is the difference
// between a library and a check, which a naming convention could only imply.
for await (const file of new Glob("*.hs").scan({ cwd: "gates" })) {
  const name = file.split(/[/\\]/).pop() ?? file;
  if (!readFileSync(`gates/${file}`, "utf8").includes("module Main")) continue;
  onDisk.push(name);
}

if (onDisk.length === 0) {
  console.error(
    "FAIL  verify:gates-run: found no gate scripts — the scan is looking in the wrong place",
  );
  process.exit(1);
}

// What actually invokes a gate: the runner, and the package manifest.
const runner = readFileSync("scripts/gate.ts", "utf8");
const manifest = readFileSync("package.json", "utf8");
const invocations = `${runner}\n${manifest}`;

const orphans = onDisk.filter(
  (name) =>
    !invocations.includes(name) &&
    !invocations.includes(`verify:${name.replace(/^verify-|\.ts$/g, "")}`),
);

// The other direction: a stage the runner names but no file backs.
const staged = [
  ...runner.matchAll(/scripts\/(verify-[\w-]+\.ts)/g),
  ...runner.matchAll(/gates\/([\w-]+\.hs)/g),
].map((m) => m[1]);
const missing = staged.filter((name) => name !== undefined && !onDisk.includes(name));

if (orphans.length > 0 || missing.length > 0) {
  console.error("FAIL  verify:gates-run");
  for (const name of orphans)
    console.error(`      orphan: scripts/${name} exists but nothing runs it`);
  for (const name of missing)
    console.error(`      missing: gate.ts runs a gate named ${name}, which is absent`);
  process.exit(1);
}

console.log(`PASS  verify:gates-run  (${onDisk.length} gates on disk, all invoked)`);
