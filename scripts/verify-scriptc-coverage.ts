#!/usr/bin/env bun
/**
 * D15: ScriptC ownership of every build-time program, measured rather than declared.
 *
 * SCRIPTC_PROGRAMS contains the fully static source gates and the production
 * release packager. Each entry runs as a compiled executable with no Bun
 * fallback. Every other scripts/verify-*.ts file stays on Bun because ScriptC
 * reports one or more unsupported constructs; this gate prints those SC codes.
 *
 * What fails:
 *
 * 1. A listed program no longer measures `fully static`. Its executable would
 *    no longer represent the complete source program.
 * 2. A verification script measures `fully static` but is absent from
 *    SCRIPTC_PROGRAMS. The measured ownership table has gone stale.
 *
 * The release program is checked even though its name does not start with
 * `verify-`. SCRIPTC_RELEASE_SOURCE lets its counterfactual test substitute one
 * isolated dynamic source. It does not change production membership.
 *
 * The compiler is the one `bun.lock` resolved for the Native SDK
 * (`scriptc-compiler.ts`), never one from PATH. Measuring with a different
 * compiler than the one that builds the executables would report coverage for
 * a program nobody runs. Without the dependency installed the gate reports a
 * capability failure and exits non-zero; it never reports a pass it did not
 * measure.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mapConcurrent, run } from "./command-pool.ts";
import { scriptcCommand } from "./scriptc-compiler.ts";
import { RELEASE_ASSETS_SOURCE, SCRIPTC_PROGRAMS } from "./scriptc-tiers.ts";

let compiler: string;
let bootstrap: string;
try {
  [compiler, bootstrap] = scriptcCommand();
} catch (error: unknown) {
  console.error("FAIL  verify:scriptc-coverage: capability failure");
  console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const probe = spawnSync(compiler, [bootstrap, "--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.error("FAIL  verify:scriptc-coverage: the resolved ScriptC did not run");
  console.error(`      ${bootstrap} exited ${probe.status ?? "on a signal"}; run bun install`);
  process.exit(1);
}

const releaseSource = process.env.SCRIPTC_RELEASE_SOURCE ?? RELEASE_ASSETS_SOURCE;
const isolatedReleaseProbe = process.env.SCRIPTC_RELEASE_SOURCE !== undefined;
const verificationScripts = readdirSync("scripts")
  .filter((entry) => entry.startsWith("verify-") && entry.endsWith(".ts"))
  .map((entry) => `scripts/${entry}`);
const scripts = (
  isolatedReleaseProbe ? [releaseSource] : [...verificationScripts, releaseSource]
).sort();

const listed = new Set(isolatedReleaseProbe ? [releaseSource] : Object.values(SCRIPTC_PROGRAMS));
const staleMembers: string[] = [];
const missingMembers: string[] = [];
const blocked: Array<{ readonly script: string; readonly codes: string }> = [];

// One `scriptc coverage` per script, and they do not see each other. Serially
// this gate was the slowest in the whole run at 40.6 seconds for 37 scripts —
// almost all of it process startup. `mapConcurrent` keeps the findings in
// script order, so the report stays byte-identical between runs.
const measured = await mapConcurrent(scripts, async (script) => {
  const result = await run([compiler, bootstrap, "coverage", script]);
  return { script, output: result.output };
});

for (const { script, output } of measured) {
  const isStatic = /fully static/i.test(output);
  if (isStatic && !listed.has(script)) missingMembers.push(script);
  if (!isStatic && listed.has(script)) staleMembers.push(script);
  if (!isStatic) {
    const codes = [...new Set(output.match(/SC\d{4}/g) ?? [])].sort();
    blocked.push({ script, codes: codes.length > 0 ? codes.join(",") : "no code reported" });
  }
}

if (staleMembers.length > 0 || missingMembers.length > 0) {
  console.error(
    "FAIL  verify:scriptc-coverage: ScriptC program ownership does not match measurement",
  );
  for (const script of staleMembers) {
    if (script === releaseSource) {
      console.error(
        `      release-assets production program ${script} no longer compiles fully static`,
      );
    } else {
      console.error(`      ${script} is in SCRIPTC_PROGRAMS but no longer compiles fully static`);
    }
  }
  for (const script of missingMembers) {
    console.error(`      ${script} compiles fully static but is missing from SCRIPTC_PROGRAMS`);
  }
  process.exit(1);
}

console.log(
  `PASS  verify:scriptc-coverage  (${Object.keys(SCRIPTC_PROGRAMS).length} programs compiled by ScriptC, ${blocked.length} scripts require Bun)`,
);
for (const { script, codes } of blocked) console.log(`      ${script}  ${codes}`);
