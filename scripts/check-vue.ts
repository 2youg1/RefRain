#!/usr/bin/env bun
/**
 * Run Vue's real type checker when it supports the pinned TypeScript version.
 *
 * vue-tsc 3.3.8 cannot bootstrap against TypeScript 7. Bun reports that defect
 * differently on developer machines and hosted runners. Source diagnostics and
 * every other failure remain red.
 */

import { spawnSync } from "node:child_process";

export const isKnownVueTscBootstrapFailure = (output: string): boolean => {
  const normalised = output.replaceAll("\\", "/");
  return (
    output.includes("typescript/lib/tsc") ||
    (normalised.includes("vue-tsc@3.3.8") && normalised.includes("vue-tsc/index.js:69"))
  );
};

if (import.meta.main) {
  const probe = spawnSync("bun", ["x", "vue-tsc", "--noEmit", "-p", "tsconfig.app.json"], {
    cwd: "apps/desktop",
    encoding: "utf8",
  });
  const output = `${probe.stdout}${probe.stderr}`;

  if (probe.status === 0) {
    console.log("PASS  check:vue: vue-tsc checked the desktop application");
    process.exit(0);
  }

  if (!isKnownVueTscBootstrapFailure(output)) {
    console.error(`FAIL  check:vue: vue-tsc exited ${probe.status ?? "by signal"}`);
    console.error(output.trim());
    process.exit(1);
  }

  console.log("SKIP  check:vue: vue-tsc 3.3.8 cannot bootstrap against TypeScript 7");
  console.log("      Plain .ts files are checked; Vue script blocks remain a known gap.");
}
