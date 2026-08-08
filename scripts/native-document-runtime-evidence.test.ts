import { describe, expect, test } from "bun:test";
import {
  assertNativeRuntimeExecutable,
  assessNativeRuntimeEvidence,
  buildSharedDocumentFixture,
  type NativeRuntimeEvidence,
  nativeRuntimeEnvironment,
  summarizeRuntimeSamples,
  validateRuntimeSnapshot,
  validateRuntimeSnapshotPublications,
} from "./native-document-runtime-evidence.ts";

function metricSummary(values: readonly number[]) {
  const samples = [...values];
  const ordered = [...samples].sort((left, right) => left - right);
  const at = (fraction: number): number =>
    ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.NaN;
  return { samples, p50: at(0.5), p95: at(0.95), max: ordered.at(-1) ?? Number.NaN };
}

function runtimeEvidence(overrides?: {
  readonly scaleColdStartNs?: readonly number[];
  readonly ordinaryIncrementalRssKiB?: readonly number[];
  readonly scaleIncrementalRssKiB?: readonly number[];
}): NativeRuntimeEvidence {
  const baseline = Array.from({ length: 20 }, () => ({ coldStartNs: 80_000_000, rssKiB: 84_000 }));
  const ordinary = Array.from({ length: 20 }, () => ({
    coldStartNs: 120_000_000,
    rssKiB: 85_000,
  }));
  const scaleColdStartNs =
    overrides?.scaleColdStartNs ?? Array.from({ length: 20 }, () => 160_000_000);
  const scale = scaleColdStartNs.map((coldStartNs) => ({ coldStartNs, rssKiB: 117_000 }));
  const ordinaryIncremental =
    overrides?.ordinaryIncrementalRssKiB ?? Array.from({ length: 20 }, () => 1_000);
  const scaleIncremental =
    overrides?.scaleIncrementalRssKiB ?? Array.from({ length: 20 }, () => 33_000);
  return {
    implementation: "native-rust-document-surface",
    runsPerTier: 20,
    fixtures: {
      baseline: { blocks: 0, bytes: 0 },
      ordinary: { blocks: 1_000, bytes: 119_538 },
      scale: { blocks: 100_000, bytes: 11_953_766 },
    },
    tiers: {
      baseline: summarizeRuntimeSamples(baseline),
      ordinary: summarizeRuntimeSamples(ordinary),
      scale: summarizeRuntimeSamples(scale),
    },
    incrementalRssKiB: {
      ordinary: metricSummary(ordinaryIncremental),
      scale: metricSummary(scaleIncremental),
    },
  };
}

describe("Native runtime evidence", () => {
  test("builds the exact shared 100,000-block fixture", () => {
    const fixture = buildSharedDocumentFixture(100_000, 11_953_766);
    const text = new TextDecoder().decode(fixture);

    expect(fixture.byteLength).toBe(11_953_766);
    expect(text.split("\n\n")).toHaveLength(100_000);
    expect(text.startsWith("000000 | 中文と日本語 | ")).toBe(true);
    expect(text.includes("999999 | 中文と日本語 | ")).toBe(false);
    expect(text.includes("099999 | 中文と日本語 | ")).toBe(true);
  });

  test("removes the in-memory scale fixture from real document launches", () => {
    const environment = nativeRuntimeEnvironment(
      { REFRAIN_NATIVE_SCALE_FIXTURE: "1", KEEP_ME: "yes" },
      {
        display: ":99",
        runtimeDir: "/tmp/runtime",
        root: "/tmp/Root",
        appDb: "/tmp/app.db",
      },
    );

    expect(environment.REFRAIN_NATIVE_SCALE_FIXTURE).toBeUndefined();
    expect(environment.KEEP_ME).toBe("yes");
    expect(environment.REFRAIN_NATIVE_ROOT).toBe("/tmp/Root");
    expect(environment.REFRAIN_NATIVE_DOCUMENT).toBe("document.md");
  });

  test("uses nearest-rank percentiles for independent process samples", () => {
    const summary = summarizeRuntimeSamples([
      { coldStartNs: 5, rssKiB: 50 },
      { coldStartNs: 1, rssKiB: 10 },
      { coldStartNs: 4, rssKiB: 40 },
      { coldStartNs: 2, rssKiB: 20 },
      { coldStartNs: 3, rssKiB: 30 },
    ]);

    expect(summary.coldStartNs.p50).toBe(3);
    expect(summary.coldStartNs.p95).toBe(5);
    expect(summary.rssKiB.p50).toBe(30);
    expect(summary.rssKiB.p95).toBe(50);
  });

  test("accepts 20 independently sampled processes inside cold-start and RSS budgets", () => {
    const assessment = assessNativeRuntimeEvidence(runtimeEvidence());

    expect(assessment.passed).toBe(true);
    expect(Object.values(assessment.checks).every(Boolean)).toBe(true);
  });

  test("preserves finite negative incremental RSS noise during summary verification", () => {
    const assessment = assessNativeRuntimeEvidence(
      runtimeEvidence({
        ordinaryIncrementalRssKiB: Array.from({ length: 20 }, () => -1_000),
      }),
    );

    expect(assessment.checks.finiteIncrementalRssSamples).toBe(true);
    expect(assessment.checks.summaryIntegrity).toBe(true);
    expect(assessment.passed).toBe(true);
  });

  test("rejects one cold-start outlier above the maximum budget", () => {
    const samples = [...Array.from({ length: 19 }, () => 160_000_000), 260_000_000];
    const assessment = assessNativeRuntimeEvidence(runtimeEvidence({ scaleColdStartNs: samples }));

    expect(assessment.checks.scaleColdStartP95).toBe(true);
    expect(assessment.checks.scaleColdStartMax).toBe(false);
    expect(assessment.passed).toBe(false);
  });

  test("rejects one scale RSS outlier above the maximum budget", () => {
    const samples = [...Array.from({ length: 19 }, () => 33_000), 50_000];
    const assessment = assessNativeRuntimeEvidence(
      runtimeEvidence({ scaleIncrementalRssKiB: samples }),
    );

    expect(assessment.checks.scaleIncrementalRssP95).toBe(true);
    expect(assessment.checks.scaleIncrementalRssMax).toBe(false);
    expect(assessment.passed).toBe(false);
  });

  // /proc/<pid>/exe 是 Linux 专有的机制：Windows 上没有这个文件系统，
  // 该断言的命题在那边不成立。Windows 的 CI 与本地跑跳过它，Linux CI 照跑。
  test.skipIf(process.platform === "win32")(
    "binds every sample to the expected process executable",
    () => {
      expect(() => assertNativeRuntimeExecutable(process.pid, process.execPath)).not.toThrow();
      expect(() => assertNativeRuntimeExecutable(process.pid, "/bin/false")).toThrow(
        "does not run expected executable",
      );
    },
  );

  test("binds a snapshot to its spawned process and fixture", () => {
    const snapshot = `ready=true publisher_pid=73 gpu_nonblank=true dispatch_errors=0
protocol 3 · session 1 · revision 0 · 1000 blocks · 119538 bytes`;

    expect(() =>
      validateRuntimeSnapshot(snapshot, { publisherPid: 73, blocks: 1_000, bytes: 119_538 }),
    ).not.toThrow();
    expect(() =>
      validateRuntimeSnapshot(snapshot, { publisherPid: 74, blocks: 1_000, bytes: 119_538 }),
    ).toThrow("publisher 73 is not spawned process 74");
    expect(() =>
      validateRuntimeSnapshot(snapshot, { publisherPid: 73, blocks: 1_000, bytes: 119_539 }),
    ).toThrow(
      "does not prove 1000 blocks and 119539 bytes; observed protocol 3 · session 1 · revision 0 · 1000 blocks · 119538 bytes",
    );
  });

  test("accepts changing frame data only when both snapshot publications prove the fixture", () => {
    const commandOutput = `ready=true publisher_pid=73 gpu_nonblank=true dispatch_errors=0 frame=4
protocol 3 · session 1 · revision 0 · 1000 blocks · 119538 bytes`;
    const deliveredFile = `ready=true publisher_pid=73 gpu_nonblank=true dispatch_errors=0 frame=5
protocol 3 · session 1 · revision 0 · 1000 blocks · 119538 bytes`;
    const expectation = { publisherPid: 73, blocks: 1_000, bytes: 119_538 } as const;

    expect(() =>
      validateRuntimeSnapshotPublications(commandOutput, deliveredFile, expectation),
    ).not.toThrow();
    expect(() =>
      validateRuntimeSnapshotPublications(
        commandOutput,
        deliveredFile.replace("119538 bytes", "119539 bytes"),
        expectation,
      ),
    ).toThrow("delivered snapshot file");
  });

  test("rejects a ready snapshot whose product path reported an error", () => {
    const snapshot = `ready=true publisher_pid=73 gpu_nonblank=true dispatch_errors=1
protocol 3 · session 1 · revision 0 · 0 blocks · 0 bytes`;

    expect(() =>
      validateRuntimeSnapshot(snapshot, { publisherPid: 73, blocks: 0, bytes: 0 }),
    ).toThrow("dispatch_errors=0");
  });
});
