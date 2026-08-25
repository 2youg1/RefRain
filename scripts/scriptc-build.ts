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

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { scriptcCommand, scriptcVersion } from "./scriptc-compiler.ts";
import { executableFor, SCRIPTC_OUT, SCRIPTC_PROGRAMS, TIER_A } from "./scriptc-tiers.ts";

mkdirSync(SCRIPTC_OUT, { recursive: true });

const [compiler, bootstrap] = scriptcCommand();
const version = scriptcVersion();

const failures: string[] = [];
for (const [program, script] of Object.entries(SCRIPTC_PROGRAMS)) {
  const out = executableFor(script);
  const result = spawnSync(compiler, [bootstrap, "build", script, "-o", out], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-3);
    failures.push(`${program}: ${detail.join(" ")}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL  scriptc:build — ${failures.length} ScriptC programs did not compile`);
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  scriptc:build  (${Object.keys(TIER_A).length} tier A gates and ${Object.keys(SCRIPTC_PROGRAMS).length - Object.keys(TIER_A).length} release program compiled into ${SCRIPTC_OUT} by ScriptC ${version})`,
);
