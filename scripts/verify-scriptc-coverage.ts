#!/usr/bin/env bun
/**
 * D15: the ScriptC tier of every build-time script, measured rather than declared.
 *
 * Three tiers, and the point of the gate is that all three stay visible:
 *
 * - **A** — `scriptc coverage` says `fully static`. The gate runs as a compiled
 *   executable with no Bun fallback.
 * - **B/C** — a named SC error code blocks the compile. These keep running under
 *   Bun, and this gate prints the code so the debt has a name instead of a
 *   number. Some are ours to rewrite (tier B), some wait for upstream lowering
 *   (tier C); the distinction is a judgement, so this gate reports the measured
 *   codes and does not guess which is which.
 *
 * What fails:
 *
 * 1. A script listed in TIER_A that no longer measures `fully static` — the
 *    membership claim went stale, and its gate would run a compiled program
 *    that no longer represents the source.
 * 2. A script that measures `fully static` but is missing from TIER_A — free
 *    coverage left on the table, and silence about it is how the list rots.
 *
 * Injection proof that this bites: add a dynamic construct to a tier A script
 * (an `eval`, a `for await`) and case 1 fires by name; delete an entry from
 * TIER_A and case 2 fires by name.
 *
 * This gate needs `scriptc` on PATH. Without it the gate reports a capability
 * failure and exits non-zero — it never reports a pass it did not measure.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { TIER_A } from "./scriptc-tiers.ts";

const probe = spawnSync("scriptc", ["--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.error("FAIL  verify:scriptc-coverage: scriptc is not on PATH (capability failure)");
  console.error("      install it with: bun install --global scriptc@0.0.21");
  process.exit(1);
}

const scripts = readdirSync("scripts")
  .filter((entry) => entry.startsWith("verify-") && entry.endsWith(".ts"))
  .map((entry) => `scripts/${entry}`)
  .sort();

const listed = new Set(Object.values(TIER_A));
const staleMembers: string[] = [];
const missingMembers: string[] = [];
const blocked: Array<{ readonly script: string; readonly codes: string }> = [];

for (const script of scripts) {
  const result = spawnSync("scriptc", ["coverage", script], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const isStatic = /fully static/i.test(output);
  if (isStatic && !listed.has(script)) missingMembers.push(script);
  if (!isStatic && listed.has(script)) staleMembers.push(script);
  if (!isStatic) {
    const codes = [...new Set(output.match(/SC\d{4}/g) ?? [])].sort();
    blocked.push({ script, codes: codes.length > 0 ? codes.join(",") : "no code reported" });
  }
}

if (staleMembers.length > 0 || missingMembers.length > 0) {
  console.error("FAIL  verify:scriptc-coverage: the tier A list does not match the measurement");
  for (const script of staleMembers) {
    console.error(`      ${script} is in TIER_A but no longer compiles fully static`);
  }
  for (const script of missingMembers) {
    console.error(`      ${script} compiles fully static but is missing from TIER_A`);
  }
  process.exit(1);
}

console.log(
  `PASS  verify:scriptc-coverage  (${Object.keys(TIER_A).length} tier A compiled, ${blocked.length} blocked under Bun)`,
);
for (const { script, codes } of blocked) console.log(`      ${script}  ${codes}`);
