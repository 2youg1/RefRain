import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNativeAutomationStderr,
  assertNativeRuntimeStderr,
} from "./native-document-performance-policy.ts";

export interface RuntimeSample {
  readonly coldStartNs: number;
  readonly rssKiB: number;
}

export interface MetricSummary {
  readonly samples: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface RuntimeSampleSummary {
  readonly coldStartNs: MetricSummary;
  readonly rssKiB: MetricSummary;
}

export interface RuntimeSnapshotExpectation {
  readonly publisherPid: number;
  readonly blocks: number;
  readonly bytes: number;
}

export interface NativeRuntimeEvidenceOptions {
  readonly nativeDir: string;
  readonly nativeCli: string;
  readonly executable: string;
  readonly automationDir: string;
  readonly temporaryRoot: string;
  readonly display: string;
  readonly runs: number;
}

export interface NativeRuntimeEnvironmentOptions {
  readonly display: string;
  readonly runtimeDir: string;
  readonly root: string;
  readonly appDb: string;
}

export const NATIVE_RUNTIME_EVIDENCE_RUNS = 20;
export const SCALE_COLD_START_P95_BUDGET_NS = 200_000_000;
export const SCALE_COLD_START_MAX_BUDGET_NS = 250_000_000;
export const SCALE_INCREMENTAL_RSS_P95_BUDGET_KIB = 40 * 1_024;
export const SCALE_INCREMENTAL_RSS_MAX_BUDGET_KIB = 48 * 1_024;

export interface NativeRuntimeEvidenceAssessment {
  readonly budgets: {
    readonly scaleColdStartP95Ns: number;
    readonly scaleColdStartMaxNs: number;
    readonly scaleIncrementalRssP95KiB: number;
    readonly scaleIncrementalRssMaxKiB: number;
  };
  readonly checks: {
    readonly implementation: boolean;
    readonly runsPerTier: boolean;
    readonly fixtureIdentity: boolean;
    readonly finiteNonnegativeProcessSamples: boolean;
    readonly finiteIncrementalRssSamples: boolean;
    readonly sampleCounts: boolean;
    readonly summaryIntegrity: boolean;
    readonly scaleColdStartP95: boolean;
    readonly scaleColdStartMax: boolean;
    readonly scaleIncrementalRssP95: boolean;
    readonly scaleIncrementalRssMax: boolean;
  };
  readonly passed: boolean;
}

export interface NativeRuntimeEvidence {
  readonly implementation: "native-rust-document-surface";
  readonly runsPerTier: number;
  readonly fixtures: {
    readonly baseline: { readonly blocks: 0; readonly bytes: 0 };
    readonly ordinary: { readonly blocks: 1_000; readonly bytes: 119_538 };
    readonly scale: { readonly blocks: 100_000; readonly bytes: 11_953_766 };
  };
  readonly tiers: {
    readonly baseline: RuntimeSampleSummary;
    readonly ordinary: RuntimeSampleSummary;
    readonly scale: RuntimeSampleSummary;
  };
  readonly incrementalRssKiB: {
    readonly ordinary: MetricSummary;
    readonly scale: MetricSummary;
  };
}

type RuntimeTier = "baseline" | "ordinary" | "scale";

interface RuntimeFixture {
  readonly tier: RuntimeTier;
  readonly blocks: number;
  readonly bytes: Uint8Array;
  readonly root: string;
  readonly appDb: string;
  readonly runtimeDir: string;
}

export function buildSharedDocumentFixture(blocks: number, bytes: number): Uint8Array {
  if (!Number.isSafeInteger(blocks) || blocks <= 0) {
    throw new Error("shared document fixture requires a positive integer block count");
  }
  if (!Number.isSafeInteger(bytes) || bytes <= (blocks - 1) * 2) {
    throw new Error("shared document fixture has no room for block content");
  }
  const separatorBytes = (blocks - 1) * 2;
  const contentBytes = bytes - separatorBytes;
  const baseBlockBytes = Math.floor(contentBytes / blocks);
  const longerBlocks = contentBytes % blocks;
  const encoder = new TextEncoder();
  const content = Array.from({ length: blocks }, (_, index) => {
    const length = baseBlockBytes + (index < longerBlocks ? 1 : 0);
    const prefix = `${String(index).padStart(6, "0")} | 中文と日本語 | `;
    const prefixBytes = encoder.encode(prefix).byteLength;
    if (prefixBytes > length) {
      throw new Error(`shared document fixture block ${index} is shorter than its prefix`);
    }
    return prefix + String.fromCharCode(0x61 + (index % 26)).repeat(length - prefixBytes);
  }).join("\n\n");
  const fixture = encoder.encode(content);
  if (fixture.byteLength !== bytes) {
    throw new Error(`shared document fixture wrote ${fixture.byteLength} bytes, expected ${bytes}`);
  }
  return fixture;
}

export function assertNativeRuntimeExecutable(pid: number, expectedExecutable: string): void {
  const observed = realpathSync(`/proc/${pid}/exe`);
  const expected = realpathSync(expectedExecutable);
  if (observed !== expected) {
    throw new Error(
      `Native runtime process ${pid} runs ${observed} and does not run expected executable ${expected}`,
    );
  }
}

export function nativeRuntimeEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  options: NativeRuntimeEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment = { ...base };
  delete environment.REFRAIN_NATIVE_SCALE_FIXTURE;
  environment.DISPLAY = options.display;
  environment.GDK_BACKEND = "x11";
  environment.XDG_RUNTIME_DIR = options.runtimeDir;
  environment.REFRAIN_NATIVE_ROOT = options.root;
  environment.REFRAIN_NATIVE_DOCUMENT = "document.md";
  environment.REFRAIN_NATIVE_APP_DB = options.appDb;
  return environment;
}

export async function collectNativeRuntimeEvidence(
  options: NativeRuntimeEvidenceOptions,
): Promise<NativeRuntimeEvidence> {
  if (!Number.isSafeInteger(options.runs) || options.runs < 3) {
    throw new Error("Native runtime evidence requires at least three independent runs per tier");
  }
  const fixtures = prepareRuntimeFixtures(options.temporaryRoot);
  const samples: Record<RuntimeTier, RuntimeSample[]> = {
    baseline: [],
    ordinary: [],
    scale: [],
  };
  try {
    for (const fixture of fixtures) await measureRuntimeFixture(options, fixture);
    for (let run = 0; run < options.runs; run += 1) {
      for (const fixture of fixtures) {
        samples[fixture.tier].push(await measureRuntimeFixture(options, fixture));
      }
    }
    const ordinaryIncrement = pairedRssDelta(samples.baseline, samples.ordinary);
    const scaleIncrement = pairedRssDelta(samples.baseline, samples.scale);
    return {
      implementation: "native-rust-document-surface",
      runsPerTier: options.runs,
      fixtures: {
        baseline: { blocks: 0, bytes: 0 },
        ordinary: { blocks: 1_000, bytes: 119_538 },
        scale: { blocks: 100_000, bytes: 11_953_766 },
      },
      tiers: {
        baseline: summarizeRuntimeSamples(samples.baseline),
        ordinary: summarizeRuntimeSamples(samples.ordinary),
        scale: summarizeRuntimeSamples(samples.scale),
      },
      incrementalRssKiB: {
        ordinary: summarize(ordinaryIncrement, true),
        scale: summarize(scaleIncrement, true),
      },
    };
  } finally {
    rmSync(options.automationDir, { force: true, recursive: true });
    rmSync(options.temporaryRoot, { force: true, recursive: true });
  }
}

function prepareRuntimeFixtures(temporaryRoot: string): readonly RuntimeFixture[] {
  rmSync(temporaryRoot, { force: true, recursive: true });
  const specifications = [
    { tier: "baseline", blocks: 0, bytes: new Uint8Array(0) },
    { tier: "ordinary", blocks: 1_000, bytes: buildSharedDocumentFixture(1_000, 119_538) },
    { tier: "scale", blocks: 100_000, bytes: buildSharedDocumentFixture(100_000, 11_953_766) },
  ] as const;
  return specifications.map((specification) => {
    const base = join(temporaryRoot, specification.tier);
    const root = join(base, "Root");
    const runtimeDir = join(base, "runtime");
    mkdirSync(root, { mode: 0o700, recursive: true });
    mkdirSync(runtimeDir, { mode: 0o700, recursive: true });
    writeFileSync(join(root, "document.md"), specification.bytes);
    return {
      tier: specification.tier,
      blocks: specification.blocks,
      bytes: specification.bytes,
      root,
      appDb: join(base, "app.db"),
      runtimeDir,
    };
  });
}

async function measureRuntimeFixture(
  options: NativeRuntimeEvidenceOptions,
  fixture: RuntimeFixture,
): Promise<RuntimeSample> {
  rmSync(options.automationDir, { force: true, recursive: true });
  const startedAt = Bun.nanoseconds();
  const runtime = Bun.spawn([options.executable], {
    cwd: options.nativeDir,
    env: nativeRuntimeEnvironment(process.env, {
      display: options.display,
      runtimeDir: fixture.runtimeDir,
      root: fixture.root,
      appDb: fixture.appDb,
    }),
    stdout: "ignore",
    stderr: "pipe",
  });
  const runtimeStderr = new Response(runtime.stderr).text();
  try {
    await waitForRuntimeSnapshot(options, fixture, runtime.pid, runtime);
    assertNativeRuntimeExecutable(runtime.pid, options.executable);
    const rssKiB = await residentMemoryKiB(runtime.pid);
    return {
      coldStartNs: Bun.nanoseconds() - startedAt,
      rssKiB,
    };
  } finally {
    if (runtime.exitCode === null) runtime.kill();
    await runtime.exited;
    assertNativeRuntimeStderr(await runtimeStderr);
  }
}

async function waitForRuntimeSnapshot(
  options: NativeRuntimeEvidenceOptions,
  fixture: RuntimeFixture,
  publisherPid: number,
  runtime: Bun.Subprocess,
): Promise<string> {
  const deadline = Bun.nanoseconds() + 30_000_000_000;
  let lastFailure = "automation publisher did not become ready";
  while (Bun.nanoseconds() < deadline) {
    if (runtime.exitCode !== null) {
      throw new Error(`Native runtime exited with ${runtime.exitCode} before publishing evidence`);
    }
    const result = Bun.spawnSync([options.nativeCli, "automate", "snapshot"], {
      cwd: options.nativeDir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = result.stderr.toString();
    if (result.exitCode === 0) {
      try {
        assertNativeAutomationStderr(stderr, "snapshot", options.automationDir);
        const commandOutput = result.stdout.toString();
        const deliveredFile = await Bun.file(join(options.automationDir, "snapshot.txt")).text();
        validateRuntimeSnapshotPublications(commandOutput, deliveredFile, {
          publisherPid,
          blocks: fixture.blocks,
          bytes: fixture.bytes.byteLength,
        });
        return commandOutput;
      } catch (error: unknown) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
    } else {
      lastFailure = `native automate snapshot failed with ${result.exitCode}: ${stderr.trim()}`;
    }
    await Bun.sleep(5);
  }
  throw new Error(
    `Native runtime did not publish complete evidence within 30 seconds\n${lastFailure}`,
  );
}

async function residentMemoryKiB(pid: number): Promise<number> {
  const status = await Bun.file(`/proc/${pid}/status`).text();
  const value = status.match(/^VmRSS:\s+([0-9]+)\s+kB$/m)?.[1];
  if (value === undefined) throw new Error(`Native runtime process ${pid} has no VmRSS`);
  return Number(value);
}

function pairedRssDelta(
  baseline: readonly RuntimeSample[],
  candidate: readonly RuntimeSample[],
): readonly number[] {
  if (baseline.length !== candidate.length || baseline.length === 0) {
    throw new Error("Native runtime RSS tiers do not have paired process samples");
  }
  return candidate.map((sample, index) => {
    const base = baseline[index];
    if (base === undefined) throw new Error(`Native runtime baseline sample ${index} is missing`);
    return sample.rssKiB - base.rssKiB;
  });
}

export function summarizeRuntimeSamples(samples: readonly RuntimeSample[]): RuntimeSampleSummary {
  if (samples.length === 0) throw new Error("Native runtime evidence requires process samples");
  return {
    coldStartNs: summarize(samples.map((sample) => sample.coldStartNs)),
    rssKiB: summarize(samples.map((sample) => sample.rssKiB)),
  };
}

export function assessNativeRuntimeEvidence(
  evidence: NativeRuntimeEvidence,
): NativeRuntimeEvidenceAssessment {
  const processSummaries = [
    evidence.tiers.baseline.coldStartNs,
    evidence.tiers.baseline.rssKiB,
    evidence.tiers.ordinary.coldStartNs,
    evidence.tiers.ordinary.rssKiB,
    evidence.tiers.scale.coldStartNs,
    evidence.tiers.scale.rssKiB,
  ];
  const incrementalSummaries = [
    evidence.incrementalRssKiB.ordinary,
    evidence.incrementalRssKiB.scale,
  ];
  const summaries = [...processSummaries, ...incrementalSummaries];
  const checks = {
    implementation: evidence.implementation === "native-rust-document-surface",
    runsPerTier: evidence.runsPerTier === NATIVE_RUNTIME_EVIDENCE_RUNS,
    fixtureIdentity:
      evidence.fixtures.baseline.blocks === 0 &&
      evidence.fixtures.baseline.bytes === 0 &&
      evidence.fixtures.ordinary.blocks === 1_000 &&
      evidence.fixtures.ordinary.bytes === 119_538 &&
      evidence.fixtures.scale.blocks === 100_000 &&
      evidence.fixtures.scale.bytes === 11_953_766,
    finiteNonnegativeProcessSamples: processSummaries.every((summary) =>
      summary.samples.every((value) => Number.isFinite(value) && value >= 0),
    ),
    finiteIncrementalRssSamples: incrementalSummaries.every((summary) =>
      summary.samples.every(Number.isFinite),
    ),
    sampleCounts: summaries.every(
      (summary) => summary.samples.length === NATIVE_RUNTIME_EVIDENCE_RUNS,
    ),
    summaryIntegrity:
      processSummaries.every((summary) => metricSummaryMatchesSamples(summary, false)) &&
      incrementalSummaries.every((summary) => metricSummaryMatchesSamples(summary, true)),
    scaleColdStartP95: evidence.tiers.scale.coldStartNs.p95 <= SCALE_COLD_START_P95_BUDGET_NS,
    scaleColdStartMax: evidence.tiers.scale.coldStartNs.max <= SCALE_COLD_START_MAX_BUDGET_NS,
    scaleIncrementalRssP95:
      evidence.incrementalRssKiB.scale.p95 <= SCALE_INCREMENTAL_RSS_P95_BUDGET_KIB,
    scaleIncrementalRssMax:
      evidence.incrementalRssKiB.scale.max <= SCALE_INCREMENTAL_RSS_MAX_BUDGET_KIB,
  };
  return {
    budgets: {
      scaleColdStartP95Ns: SCALE_COLD_START_P95_BUDGET_NS,
      scaleColdStartMaxNs: SCALE_COLD_START_MAX_BUDGET_NS,
      scaleIncrementalRssP95KiB: SCALE_INCREMENTAL_RSS_P95_BUDGET_KIB,
      scaleIncrementalRssMaxKiB: SCALE_INCREMENTAL_RSS_MAX_BUDGET_KIB,
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function metricSummaryMatchesSamples(summary: MetricSummary, allowNegative: boolean): boolean {
  if (summary.samples.length === 0) return false;
  const calculated = summarize(summary.samples, allowNegative);
  return (
    summary.p50 === calculated.p50 &&
    summary.p95 === calculated.p95 &&
    summary.max === calculated.max
  );
}

export function validateRuntimeSnapshotPublications(
  commandOutput: string,
  deliveredFile: string,
  expectation: RuntimeSnapshotExpectation,
): void {
  try {
    validateRuntimeSnapshot(commandOutput, expectation);
  } catch (error: unknown) {
    throw new Error(
      `Native automate snapshot stdout is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    validateRuntimeSnapshot(deliveredFile, expectation);
  } catch (error: unknown) {
    throw new Error(
      `Native delivered snapshot file is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateRuntimeSnapshot(
  snapshot: string,
  expectation: RuntimeSnapshotExpectation,
): void {
  for (const required of ["ready=true", "gpu_nonblank=true", "dispatch_errors=0"]) {
    if (!snapshot.includes(required)) {
      throw new Error(`Native runtime snapshot requires ${required}`);
    }
  }
  const publisher = capturedInteger(snapshot, /publisher_pid=([0-9]+)/, "publisher_pid");
  if (publisher !== expectation.publisherPid) {
    throw new Error(
      `automation publisher ${publisher} is not spawned process ${expectation.publisherPid}`,
    );
  }
  const dimensions = new RegExp(
    `protocol [0-9]+ · session [1-9][0-9]* · revision [0-9]+ · ${expectation.blocks} blocks · ${expectation.bytes} bytes`,
  );
  if (!dimensions.test(snapshot)) {
    const observed =
      snapshot.match(
        /protocol [0-9]+ · session [0-9]+ · revision [0-9]+ · [0-9]+ blocks · [0-9]+ bytes/,
      )?.[0] ?? "no protocol dimensions";
    throw new Error(
      `Native runtime snapshot does not prove ${expectation.blocks} blocks and ${expectation.bytes} bytes; observed ${observed}`,
    );
  }
}

function summarize(values: readonly number[], allowNegative = false): MetricSummary {
  for (const value of values) {
    if (!Number.isFinite(value) || (!allowNegative && value < 0)) {
      throw new Error("Native runtime evidence contains an invalid sample");
    }
  }
  return {
    samples: values,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  const value = ordered[index];
  if (value === undefined) throw new Error("percentile index is outside the sample set");
  return value;
}

function capturedInteger(text: string, pattern: RegExp, label: string): number {
  const value = text.match(pattern)?.[1];
  if (value === undefined) throw new Error(`Native runtime snapshot requires ${label}`);
  return Number(value);
}
