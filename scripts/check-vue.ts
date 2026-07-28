#!/usr/bin/env bun
/**
 * Vue single-file component type checking.
 *
 * TypeScript 7 is the native rewrite: it no longer exposes `typescript/lib/tsc`
 * through its `exports` map, and `vue-tsc` 3.3.8 — the current release — resolves
 * exactly that path. So the template type checker cannot run against the
 * TypeScript this repository pins (AGENTS: TypeScript 7 strict).
 *
 * Two ways to make this look solved, both worse than the gap:
 *
 *   - Downgrade to TypeScript 5, which contradicts the pinned toolchain.
 *   - Delete the stage, which turns a known gap into an invisible one.
 *
 * So this stage reports the gap and exits 0, while asserting the two things
 * that would make the gap silently permanent: that the checker is still
 * missing for the stated reason, and that it starts being used the moment it
 * works. When `vue-tsc` gains TypeScript 7 support this script goes red — the
 * probe below succeeds — and that is the signal to replace it with the real
 * checker.
 */

import { spawnSync } from "node:child_process";

const probe = spawnSync("bun", ["x", "vue-tsc", "--version"], { encoding: "utf8" });
const output = `${probe.stdout}${probe.stderr}`;
const blocked = output.includes("typescript/lib/tsc");

if (!blocked) {
  console.error("FAIL  check:vue: vue-tsc now runs against TypeScript 7");
  console.error(
    "      The workaround in scripts/check-vue.ts is obsolete. Replace this stage with:",
  );
  console.error("      cd apps/desktop && bun x vue-tsc --noEmit -p tsconfig.app.json");
  console.error(`      probe output: ${output.trim().split("\n")[0]}`);
  process.exit(1);
}

console.log("SKIP  check:vue: vue-tsc 3.3.8 cannot load TypeScript 7 (needs typescript/lib/tsc)");
console.log("      Plain .ts files are checked; Vue script blocks remain a known gap.");
console.log("      This stage turns red when vue-tsc gains TypeScript 7 support.");
