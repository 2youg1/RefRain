#!/usr/bin/env bun
/**
 * The gate runner.
 *
 * Prints the scripts it actually ran and how many targets each one scanned,
 * because a gate that scans nothing passes for the wrong reason (SPEC 11.1).
 * A gate reporting zero targets fails the build even when its assertions hold:
 * the most common way a guard dies is a refactor that moves the code out from
 * under a scanner still looking at the old path.
 *
 * Output never goes through a pipe here. `… | head` discards the exit code,
 * which is how a red gate reads green.
 */

import { spawnSync } from "node:child_process";

const stages: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["fmt:check", ["bun", "run", "fmt:check"]],
  ["check", ["bun", "run", "check"]],
  ["test", ["bun", "run", "test"]],
  ["verify:no-spec-upload", ["bun", "scripts/verify-no-spec-upload.ts"]],
  ["verify:no-network", ["bun", "scripts/verify-no-network.ts"]],
  ["verify:bridge", ["bun", "scripts/verify-bridge.ts"]],
  ["verify:logo", ["bun", "scripts/verify-logo.ts"]],
  ["verify:window-chrome", ["bun", "scripts/verify-window-chrome.ts"]],
  ["verify:workbench-architecture", ["bun", "scripts/verify-workbench-architecture.ts"]],
  ["verify:write-path", ["bun", "scripts/verify-write-path.ts"]],
  ["verify:core-purity", ["bun", "scripts/verify-core-purity.ts"]],
  ["verify:config-authority", ["bun", "scripts/verify-config-authority.ts"]],
  ["verify:trash-only", ["bun", "scripts/verify-trash-only.ts"]],
  ["verify:roundtrip", ["bun", "scripts/verify-roundtrip.ts"]],
  ["verify:manuscript-scale", ["bun", "scripts/verify-manuscript-scale.ts"]],
  ["verify:docs-current", ["bun", "scripts/verify-docs-current.ts"]],
  ["verify:editor-kernel", ["bun", "scripts/verify-editor-kernel.ts"]],
  ["verify:no-js", ["bun", "scripts/verify-no-js.ts"]],
  ["verify:workflows", ["bun", "scripts/verify-workflows.ts"]],
  ["verify:legacy-parity", ["bun", "scripts/verify-legacy-parity.ts"]],
  ["verify:text-surface", ["bun", "scripts/verify-text-surface.ts"]],
  ["verify:gates-run", ["bun", "scripts/verify-gates-run.ts"]],
];

const failures: string[] = [];

for (const [name, argv] of stages) {
  const started = Date.now();
  const [command, ...args] = argv;
  if (command === undefined) throw new Error(`stage ${name} has no command`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.status === 0) {
    console.log(`PASS  ${name}  (${seconds}s)`);
  } else {
    console.log(`FAIL  ${name}  (${seconds}s, exit ${result.status ?? "signal"})`);
    failures.push(name);
  }
}

console.log(`\nran ${stages.length} stages, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
