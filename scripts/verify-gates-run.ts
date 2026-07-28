#!/usr/bin/env bun
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
 * Injection proof that this gate bites: add `scripts/verify-nothing.ts` without
 * wiring it into gate.ts or package.json and this exits 1 naming it.
 */

import { Glob } from "bun";

const onDisk: string[] = [];
for await (const file of new Glob("verify-*.ts").scan({ cwd: "scripts" })) {
  onDisk.push(file.split(/[/\\]/).pop() ?? file);
}

if (onDisk.length === 0) {
  console.error("FAIL  verify:gates-run: found no gate scripts — the scan is looking in the wrong place");
  process.exit(1);
}

// What actually invokes a gate: the runner, and the package manifest.
const runner = await Bun.file("scripts/gate.ts").text();
const manifest = await Bun.file("package.json").text();
const invocations = `${runner}\n${manifest}`;

const orphans = onDisk.filter((name) => !invocations.includes(name) && !invocations.includes(`verify:${name.replace(/^verify-|\.ts$/g, "")}`));

// The other direction: a stage the runner names but no file backs.
const staged = [...runner.matchAll(/scripts\/(verify-[\w-]+\.ts)/g)].map((m) => m[1]);
const missing = staged.filter((name) => name !== undefined && !onDisk.includes(name));

if (orphans.length > 0 || missing.length > 0) {
  console.error("FAIL  verify:gates-run");
  for (const name of orphans) console.error(`      orphan: scripts/${name} exists but nothing runs it`);
  for (const name of missing) console.error(`      missing: gate.ts runs scripts/${name}, which is absent`);
  process.exit(1);
}

console.log(`PASS  verify:gates-run  (${onDisk.length} gates on disk, all invoked)`);
