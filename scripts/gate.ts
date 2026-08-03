#!/usr/bin/env bun
/** Run each selected gate without a pipe and preserve its exit status. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { executableFor, TIER_A } from "./scriptc-tiers.ts";

const stages: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Rust uses these generated corpora at compile time, so generate them first.
  ["corpora", ["bun", "scripts/freeze-corpora.ts"]],
  ["protocol:native", ["bun", "scripts/generate-native-protocol.ts", "--check"]],
  ["fmt:check", ["bun", "run", "fmt:check"]],
  ["check", ["bun", "run", "check"]],
  ["test", ["bun", "run", "test"]],
  ["verify:native-ledger", ["bun", "scripts/verify-native-migration-ledger.ts"]],
  ["verify:no-spec-upload", ["bun", "scripts/verify-no-spec-upload.ts"]],
  ["verify:readme-parity", ["bun", "scripts/verify-readme-parity.ts"]],
  ["verify:no-network", ["bun", "scripts/verify-no-network.ts"]],
  ["verify:bridge", ["bun", "scripts/verify-bridge.ts"]],
  ["verify:logo", ["bun", "scripts/verify-logo.ts"]],
  ["verify:window-chrome", ["bun", "scripts/verify-window-chrome.ts"]],
  ["verify:workbench-architecture", ["bun", "scripts/verify-workbench-architecture.ts"]],
  ["verify:component-depth", ["bun", "scripts/verify-component-depth.ts"]],
  ["verify:command-depth", ["bun", "scripts/verify-command-depth.ts"]],
  ["verify:typography", ["bun", "scripts/verify-typography.ts"]],
  ["verify:strata", ["bun", "scripts/verify-strata.ts"]],
  ["verify:corner-authority", ["bun", "scripts/verify-corner-authority.ts"]],
  ["verify:body-metrics", ["bun", "scripts/verify-body-metrics.ts"]],
  ["verify:byte-invariance", ["bun", "scripts/verify-byte-invariance.ts"]],
  ["verify:preset-divergence", ["bun", "scripts/verify-preset-divergence.ts"]],
  ["verify:mailbox-scale", ["bun", "scripts/verify-mailbox-scale.ts"]],
  ["verify:layout-parity", ["bun", "scripts/verify-layout-parity.ts"]],
  ["verify:inter-script-spacing", ["bun", "apps/desktop/e2e/inter-script-spacing.ts"]],
  ["verify:typeset-purity", ["bun", "scripts/verify-typeset-purity.ts"]],
  ["verify:effect-territory", ["bun", "scripts/verify-effect-territory.ts"]],
  ["verify:rail-indent", ["bun", "scripts/verify-rail-indent.ts"]],
  ["verify:chrome-reveal", ["bun", "scripts/verify-chrome-reveal.ts"]],
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
  ["verify:change-highlight-render", ["bun", "apps/desktop/e2e/change-highlight-render.ts"]],
  ["verify:linebreak-takeover", ["bun", "apps/desktop/e2e/verify-linebreak-takeover.ts"]],
  ["verify:inline-marks", ["bun", "apps/desktop/e2e/verify-inline-marks.ts"]],
  ["verify:table-render", ["bun", "apps/desktop/e2e/verify-table-render.ts"]],
  ["verify:diagram-render", ["bun", "apps/desktop/e2e/verify-diagram-render.ts"]],
  ["verify:settings-search", ["bun", "apps/desktop/e2e/verify-settings-search.ts"]],
  ["verify:pdf-render", ["bun", "apps/desktop/e2e/verify-pdf-render.ts"]],
  ["verify:hanging-render", ["bun", "apps/desktop/e2e/verify-hanging-render.ts"]],
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
  ["verify:verification-order", ["bun", "scripts/verify-verification-order.ts"]],
  ["verify:one-word-per-concept", ["bun", "scripts/verify-one-word-per-concept.ts"]],
  ["verify:alternates-isolation", ["bun", "scripts/verify-alternates-isolation.ts"]],
  ["verify:contract-tier-per-task", ["bun", "scripts/verify-contract-tier-per-task.ts"]],
  ["verify:release-version", ["bun", "scripts/verify-release-version.ts"]],
  ["verify:release-workflow", ["bun", "scripts/verify-release-workflow.ts"]],
  ["verify:scriptc-coverage", ["bun", "scripts/verify-scriptc-coverage.ts"]],
  ["verify:gates-run", ["bun", "scripts/verify-gates-run.ts"]],
  // 壳层接线的行为探针：真 Workbench、真点击、真浏览器——unit 与 wiring 测试
  // 都证不了 Solid 真的重渲染。需要浏览器，所以归 headless evidence。
  ["probe:shell-wiring", ["bun", "apps/desktop/e2e/probe-shell-wiring.ts"]],
];

const headlessEvidence = new Set([
  "verify:cross-block-selection",
  // 改动着色断的是屏幕上的像素几何，数据层测不到它。
  "verify:change-highlight-render",
  // 断行接管断的是屏幕上真实断在哪，切分层测不到它。
  "verify:linebreak-takeover",
  "verify:inline-marks",
  "verify:table-render",
  "verify:diagram-render",
  "verify:settings-search",
  "verify:pdf-render",
  "verify:hanging-render",
  "verify:font-fallback",
  // 侧栏缩进量的是渲染结果，所以它要一台浏览器和一个跑着的 dev server。
  "verify:rail-indent",
  "verify:chrome-reveal",
  // 壳层接线断的是真浏览器里的真点击，数据层与源码钉都测不到它。
  "probe:shell-wiring",
]);
const performanceEvidence = new Set([
  "verify:project-performance",
  "verify:large-input-performance",
]);
const headlessOnly = process.argv.includes("--headless-evidence-only");
const performanceOnly = process.argv.includes("--performance-evidence-only");
if (headlessOnly && performanceOnly) {
  throw new Error("select one evidence mode");
}
const selected = stages.filter(([name]) => {
  if (headlessOnly) return headlessEvidence.has(name);
  if (performanceOnly) return performanceEvidence.has(name);
  return !headlessEvidence.has(name) && !performanceEvidence.has(name);
});
const failures: string[] = [];

/**
 * A tier A gate runs as its compiled executable, never as `bun scripts/*.ts`.
 *
 * A missing executable fails that gate rather than falling back to Bun: with a
 * fallback the compiled artefact was never the authority, and a ScriptC
 * regression would turn no gate red (roadmap D15). Run `bun run scriptc:build`
 * first — CI does.
 */
function commandFor(name: string, argv: readonly string[]): readonly string[] {
  const script = TIER_A[name];
  if (script === undefined) return argv;
  return [executableFor(script)];
}

for (const [name, argv] of selected) {
  const started = Date.now();
  const [command, ...args] = commandFor(name, argv);
  if (command === undefined) throw new Error(`stage ${name} has no command`);
  if (TIER_A[name] !== undefined && !existsSync(command)) {
    console.log(`FAIL  ${name}  (tier A executable missing: ${command} — run scriptc:build)`);
    failures.push(name);
    continue;
  }
  const result = spawnSync(command, args, { stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.status === 0) {
    console.log(`PASS  ${name}  (${seconds}s)`);
  } else {
    console.log(`FAIL  ${name}  (${seconds}s, exit ${result.status ?? "signal"})`);
    failures.push(name);
  }
}

const kind = headlessOnly
  ? "headless evidence"
  : performanceOnly
    ? "performance evidence"
    : "blocking";
console.log(`\nran ${selected.length} ${kind} stages, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
