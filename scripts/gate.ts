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
  ["verify:no-spec-upload", ["bun", "scripts/verify-no-spec-upload.ts"]],
  ["verify:no-network", ["bun", "scripts/verify-no-network.ts"]],
  ["verify:bridge", ["bun", "scripts/verify-bridge.ts"]],
  ["verify:corner-authority", ["bun", "scripts/verify-corner-authority.ts"]],
  ["verify:effect-territory", ["bun", "scripts/verify-effect-territory.ts"]],
  ["verify:import-security", ["bun", "scripts/verify-import-security.ts"]],
  ["verify:write-path", ["bun", "scripts/verify-write-path.ts"]],
  ["verify:core-purity", ["bun", "scripts/verify-core-purity.ts"]],
  ["verify:unsafe-surface", ["bun", "scripts/verify-unsafe-surface.ts"]],
  ["verify:no-html-sink", ["bun", "scripts/verify-no-html-sink.ts"]],
  ["verify:trash-only", ["bun", "scripts/verify-trash-only.ts"]],
  ["verify:roundtrip", ["bun", "scripts/verify-roundtrip.ts"]],
  ["verify:manuscript-scale", ["bun", "scripts/verify-manuscript-scale.ts"]],
  ["verify:open-latency", ["bun", "scripts/verify-open-latency.ts"]],
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
  ["verify:native-document-performance", ["bun", "scripts/run-native-document-performance.ts"]],
  ["verify:docs-current", ["bun", "scripts/verify-docs-current.ts"]],
  ["verify:themes-current", ["bun", "scripts/verify-themes-current.ts"]],
  ["verify:font-coverage", ["bun", "scripts/verify-font-coverage.ts"]],
  ["verify:command-space", ["bun", "scripts/verify-command-space.ts"]],
  ["verify:wire-shapes", ["bun", "scripts/verify-wire-shapes.ts"]],
  ["verify:native-theme-pixels", ["bun", "scripts/verify-native-theme-pixels.ts"]],
  ["verify:editor-kernel", ["bun", "scripts/verify-editor-kernel.ts"]],
  ["verify:native-ime", ["bun", "scripts/verify-native-ime.ts"]],
  ["verify:skill-doc-current", ["bun", "scripts/verify-skill-doc-current.ts"]],
  ["verify:verification-order", ["bun", "scripts/verify-verification-order.ts"]],
  ["verify:one-word-per-concept", ["bun", "scripts/verify-one-word-per-concept.ts"]],
  ["verify:alternates-isolation", ["bun", "scripts/verify-alternates-isolation.ts"]],
  ["verify:release-version", ["bun", "scripts/verify-release-version.ts"]],
  ["verify:release-workflow", ["bun", "scripts/verify-release-workflow.ts"]],
  ["verify:scriptc-coverage", ["bun", "scripts/verify-scriptc-coverage.ts"]],
  ["verify:gates-run", ["bun", "scripts/verify-gates-run.ts"]],
];

/**
 * The stages a data-layer assertion cannot make, grouped by what each one needs
 * from the machine that runs it.
 *
 * The grouping is the point: each lane names one requirement, so a runner that
 * cannot meet it does not run the lane and does not report a colour about it.
 * A lane that runs where its requirement is absent measures the runner, not the
 * product — and a red that everybody explains away is worse than no lane.
 *
 * - `pixels` needs a GPU view: the claim is about what reaches the screen.
 * - `data-performance` needs only a release build and a disk, thus any runner
 *   can produce it. The budgets are per platform, because NTFS and ext4 do not
 *   read metadata at the same speed.
 * - `window-performance` needs a real window on the release platform, and it
 *   drives it through the automation server. A shared runner has no such
 *   window.
 */
const EVIDENCE_LANES = {
  pixels: ["verify:native-theme-pixels"],
  "data-performance": ["verify:project-performance", "verify:large-input-performance"],
  "window-performance": ["verify:native-document-performance"],
} as const;

type EvidenceLane = keyof typeof EVIDENCE_LANES;

const laneNames = Object.keys(EVIDENCE_LANES) as readonly EvidenceLane[];
const evidenceStages = new Set<string>(laneNames.flatMap((lane) => [...EVIDENCE_LANES[lane]]));

/** `--evidence <lane>[,<lane>…]`; without it the blocking gate runs. */
function requestedLanes(argv: readonly string[]): readonly EvidenceLane[] {
  const at = argv.indexOf("--evidence");
  if (at < 0) return [];
  const value = argv[at + 1];
  if (value === undefined) throw new Error(`--evidence needs a lane: ${laneNames.join(", ")}`);
  return value.split(",").map((name) => {
    if (!laneNames.includes(name as EvidenceLane)) {
      throw new Error(`unknown evidence lane ${name}; known: ${laneNames.join(", ")}`);
    }
    return name as EvidenceLane;
  });
}

const lanes = requestedLanes(process.argv);
const wanted = new Set<string>(lanes.flatMap((lane) => [...EVIDENCE_LANES[lane]]));
const selected = stages.filter(([name]) =>
  lanes.length === 0 ? !evidenceStages.has(name) : wanted.has(name),
);
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

const kind = lanes.length === 0 ? "blocking" : `${lanes.join(" + ")} evidence`;
console.log(`\nran ${selected.length} ${kind} stages, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
