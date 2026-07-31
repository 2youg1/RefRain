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
  // 语料是 freeze-corpora.ts 的产物，不入仓库；Rust 编译期用 include_str! 读它，故第一个跑。
  ["corpora", ["bun", "scripts/freeze-corpora.ts"]],
  ["fmt:check", ["bun", "run", "fmt:check"]],
  ["check", ["bun", "run", "check"]],
  ["test", ["bun", "run", "test"]],
  ["verify:no-spec-upload", ["bun", "scripts/verify-no-spec-upload.ts"]],
  ["verify:no-network", ["bun", "scripts/verify-no-network.ts"]],
  ["verify:bridge", ["bun", "scripts/verify-bridge.ts"]],
  ["verify:logo", ["bun", "scripts/verify-logo.ts"]],
  ["verify:window-chrome", ["bun", "scripts/verify-window-chrome.ts"]],
  ["verify:workbench-architecture", ["bun", "scripts/verify-workbench-architecture.ts"]],
  ["verify:component-depth", ["bun", "scripts/verify-component-depth.ts"]],
  ["verify:command-depth", ["bun", "scripts/verify-command-depth.ts"]],
  ["verify:typography", ["bun", "scripts/verify-typography.ts"]],
  ["verify:strata", ["bun", "scripts/verify-strata.ts"]],
  ["verify:fonts", ["bun", "scripts/verify-fonts.ts"]],
  ["verify:universal-menu", ["bun", "scripts/verify-universal-menu.ts"]],
  ["verify:connections", ["bun", "scripts/verify-connections.ts"]],
  ["verify:release-surface", ["bun", "scripts/verify-release-surface.ts"]],
  ["verify:import-security", ["bun", "scripts/verify-import-security.ts"]],
  ["verify:write-path", ["bun", "scripts/verify-write-path.ts"]],
  ["verify:core-purity", ["bun", "scripts/verify-core-purity.ts"]],
  ["verify:unsafe-surface", ["bun", "scripts/verify-unsafe-surface.ts"]],
  ["verify:no-html-sink", ["bun", "scripts/verify-no-html-sink.ts"]],
  ["verify:reactive-subscription", ["bun", "scripts/verify-reactive-subscription.ts"]],
  ["verify:config-authority", ["bun", "scripts/verify-config-authority.ts"]],
  ["verify:trash-only", ["bun", "scripts/verify-trash-only.ts"]],
  ["verify:roundtrip", ["bun", "scripts/verify-roundtrip.ts"]],
  ["verify:manuscript-scale", ["bun", "scripts/verify-manuscript-scale.ts"]],
  ["verify:editor-performance", ["bun", "apps/desktop/e2e/editor-performance.ts"]],
  ["verify:editor-context", ["bun", "apps/desktop/e2e/editor-context.ts"]],
  ["verify:editor-host-identity", ["bun", "apps/desktop/e2e/editor-host-identity.ts"]],
  ["verify:cross-block-selection", ["bun", "apps/desktop/e2e/cross-block-selection.ts"]],
  ["verify:font-licenses", ["bun", "scripts/verify-font-licenses.ts"]],
  ["verify:font-fallback", ["bun", "scripts/verify-font-fallback.ts"]],
  ["verify:e2e-coverage", ["bun", "scripts/verify-e2e-coverage.ts"]],
  [
    "verify:project-performance",
    [
      "cargo",
      "test",
      "--release",
      "-p",
      "refrain-store",
      "--test",
      "project_performance",
      "--",
      "--nocapture",
    ],
  ],
  [
    "verify:large-input-performance",
    [
      "cargo",
      "test",
      "--release",
      "-p",
      "refrain-store",
      "--test",
      "large_input_performance",
      "--",
      "--nocapture",
    ],
  ],
  ["verify:digest-authority", ["bun", "scripts/verify-digest-authority.ts"]],
  ["verify:docs-current", ["bun", "scripts/verify-docs-current.ts"]],
  ["verify:editor-kernel", ["bun", "scripts/verify-editor-kernel.ts"]],
  ["verify:no-js", ["bun", "scripts/verify-no-js.ts"]],
  ["verify:workflows", ["bun", "scripts/verify-workflows.ts"]],
  ["verify:legacy-parity", ["bun", "scripts/verify-legacy-parity.ts"]],
  ["verify:text-surface", ["bun", "scripts/verify-text-surface.ts"]],
  ["verify:skill-doc-current", ["bun", "scripts/verify-skill-doc-current.ts"]],
  ["verify:one-word-per-concept", ["bun", "scripts/verify-one-word-per-concept.ts"]],
  ["verify:alternates-isolation", ["bun", "scripts/verify-alternates-isolation.ts"]],
  ["verify:contract-tier-per-task", ["bun", "scripts/verify-contract-tier-per-task.ts"]],
  ["verify:release-version", ["bun", "scripts/verify-release-version.ts"]],
  ["verify:release-workflow", ["bun", "scripts/verify-release-workflow.ts"]],
  ["verify:gates-run", ["bun", "scripts/verify-gates-run.ts"]],
];

const headlessEvidence = new Set(["verify:cross-block-selection", "verify:font-fallback"]);
const evidenceOnly = process.argv.includes("--headless-evidence-only");
const selected = stages.filter(([name]) =>
  evidenceOnly ? headlessEvidence.has(name) : !headlessEvidence.has(name),
);
const failures: string[] = [];

for (const [name, argv] of selected) {
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

const kind = evidenceOnly ? "headless evidence" : "blocking";
console.log(`\nran ${selected.length} ${kind} stages, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
