#!/usr/bin/env bun
/**
 * Compile every tier A gate to a native executable.
 *
 * Run before `bun run gate` when the sources changed. CI compiles here; a
 * missing executable makes its gate fail, because a Bun fallback would mean
 * the compiled artefact was never the authority (roadmap D15).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { executableFor, SCRIPTC_OUT, TIER_A } from "./scriptc-tiers.ts";

mkdirSync(SCRIPTC_OUT, { recursive: true });

const failures: string[] = [];
for (const [gate, script] of Object.entries(TIER_A)) {
  const out = executableFor(script);
  const result = spawnSync("scriptc", ["build", script, "-o", out], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-3);
    failures.push(`${gate}: ${detail.join(" ")}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL  scriptc:build — ${failures.length} of the tier A gates did not compile`);
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  scriptc:build  (${Object.keys(TIER_A).length} tier A gates compiled into ${SCRIPTC_OUT})`,
);
