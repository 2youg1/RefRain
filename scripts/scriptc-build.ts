#!/usr/bin/env bun
/**
 * Compile every ScriptC-owned program to a native executable.
 *
 * Run before `bun run gate` when the sources changed. CI compiles here; a
 * missing executable makes its gate fail. The release program also has no
 * Bun fallback because ScriptC is the sole portable archive authority.
 *
 * The compiler comes from `scriptc-compiler.ts`, not from PATH, and the pass
 * line names the version it resolved. That line replaces the `scriptc
 * --version` step the workflows used to run beside a global install: a build
 * that cannot say which compiler produced its artefacts proves nothing about
 * them.
 */

import { mkdirSync } from "node:fs";
import { mapConcurrent, run } from "./command-pool.ts";
import { scriptcCommand, scriptcVersion } from "./scriptc-compiler.ts";
import { executableFor, SCRIPTC_OUT, SCRIPTC_PROGRAMS, TIER_A } from "./scriptc-tiers.ts";

mkdirSync(SCRIPTC_OUT, { recursive: true });

const [compiler, bootstrap] = scriptcCommand();
const version = scriptcVersion();

// Each program is an independent compile with its own output path, so the
// eighteen of them run as wide as the machine allows. Serially they cost 36 to
// 66 seconds, and every gate run and every CI job pays that before the first
// tier A gate can start.
const programs = Object.entries(SCRIPTC_PROGRAMS);
const outcomes = await mapConcurrent(programs, async ([program, script]) => {
  const result = await run([compiler, bootstrap, "build", script, "-o", executableFor(script)]);
  if (result.status === 0) return null;
  return `${program}: ${result.output.trim().split("\n").slice(-3).join(" ")}`;
});
const failures = outcomes.filter((outcome) => outcome !== null);

if (failures.length > 0) {
  console.error(`FAIL  scriptc:build — ${failures.length} ScriptC programs did not compile`);
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  scriptc:build  (${Object.keys(TIER_A).length} tier A gates and ${Object.keys(SCRIPTC_PROGRAMS).length - Object.keys(TIER_A).length} release program compiled into ${SCRIPTC_OUT} by ScriptC ${version})`,
);
