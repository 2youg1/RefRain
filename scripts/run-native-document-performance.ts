import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSourceExecutableIdentityUnchanged,
  collectSourceExecutableIdentity,
} from "./native-document-evidence-identity.ts";
import {
  assertNativeRuntimeStderr,
  parseNativeInteractionReport,
} from "./native-document-performance-policy.ts";
import {
  assessNativeRuntimeEvidence,
  collectNativeRuntimeEvidence,
  NATIVE_RUNTIME_EVIDENCE_RUNS,
} from "./native-document-runtime-evidence.ts";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "apps/native");
const nativeCli = join(nativeDir, "node_modules/.bin/native");
const executable = join(nativeDir, "zig-out/bin/refrain");
const verifier = join(root, "scripts/verify-native-document-performance.ts");
const automationDir = join(nativeDir, ".zig-cache/native-sdk-automation");
const runtimeDir = join(tmpdir(), `refrain-native-evidence-${process.pid}`);
const runtimeEvidenceRoot = join(tmpdir(), `refrain-native-process-evidence-${process.pid}`);

const display = process.env.DISPLAY;
if (display === undefined || display.length === 0) {
  throw new Error("native document performance evidence requires DISPLAY");
}

/*
 * 旧 DOM 编辑器随步骤 10 删除，所以对照组不再能当场跑出来。它最后一次实测的
 * 读数固定在这里，并且**标明是历史读数而不是本次测量**——同机、20 轮、
 * 10 万块、11,953,766 字节，mount p95 = 60.700000047683716 ms
 * （见 Roadmap 6.1 的基线表）。
 *
 * 这样做而不是删掉比较：拿掉对照组，「比旧路径快 20%」这条发布门槛就没有
 * 分母了。写死一个有出处的历史值，比悄悄改成只报绝对数诚实。
 */
const legacyReport = {
  implementation: "legacy-dom-editor",
  runs: 20,
  blocks: 100_000,
  fixtureBytes: 11_953_766,
  mountP95: 60.700000047683716,
  measuredAt: "2026-08-03, before the surface was deleted",
} as const;

const build = Bun.spawnSync(
  [nativeCli, "build", ".", "--yes", "-Dautomation=true", "-Doptimize=ReleaseFast"],
  {
    cwd: nativeDir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (build.exitCode !== 0) {
  throw new Error(
    `native automation build failed with exit ${build.exitCode}\n${build.stdout.toString()}${build.stderr.toString()}`,
  );
}

rmSync(automationDir, { force: true, recursive: true });
mkdirSync(runtimeDir, { mode: 0o700, recursive: true });

const runtime = Bun.spawn([executable], {
  cwd: nativeDir,
  env: {
    ...process.env,
    GDK_BACKEND: "x11",
    XDG_RUNTIME_DIR: runtimeDir,
    REFRAIN_NATIVE_SCALE_FIXTURE: "1",
  },
  stdout: "ignore",
  stderr: "pipe",
});
const runtimeStderr = new Response(runtime.stderr).text();

let verificationExit = 1;
let verificationStdout = "";
let verificationStderr = "";
try {
  const verification = Bun.spawn([process.execPath, verifier], {
    cwd: root,
    env: {
      ...process.env,
      REFRAIN_NATIVE_EXPECTED_PUBLISHER_PID: String(runtime.pid),
      REFRAIN_LEGACY_MOUNT_P95_MS: String(legacyReport.mountP95),
      REFRAIN_LEGACY_FIXTURE_BLOCKS: String(legacyReport.blocks),
      REFRAIN_LEGACY_FIXTURE_BYTES: String(legacyReport.fixtureBytes),
      REFRAIN_LEGACY_IMPLEMENTATION: String(legacyReport.implementation),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(verification.stdout).text(),
    new Response(verification.stderr).text(),
    verification.exited,
  ] as const);
  verificationStdout = stdout;
  verificationStderr = stderr;
  verificationExit = exit;
} finally {
  runtime.kill();
  await runtime.exited;
  rmSync(runtimeDir, { force: true, recursive: true });
}

assertNativeRuntimeStderr(await runtimeStderr);
if (verificationStderr.length > 0) {
  throw new Error(`native document verifier wrote stderr\n${verificationStderr}`);
}
if (verificationExit !== 0) {
  throw new Error(
    `native document verifier failed with exit ${verificationExit}\n${verificationStdout}`,
  );
}
const interactionReport = parseNativeInteractionReport(verificationStdout);
const runtimeEvidence = await collectNativeRuntimeEvidence({
  nativeDir,
  nativeCli,
  executable,
  automationDir,
  temporaryRoot: runtimeEvidenceRoot,
  display,
  runs: NATIVE_RUNTIME_EVIDENCE_RUNS,
});
const postRunIdentity = await collectSourceExecutableIdentity(root, executable);
assertSourceExecutableIdentityUnchanged(interactionReport.identity, postRunIdentity);
const runtimeAssessment = assessNativeRuntimeEvidence(runtimeEvidence);
const report = {
  schemaVersion: 1,
  legacy: legacyReport,
  interaction: interactionReport,
  postRunIdentity,
  independentProcesses: {
    evidence: runtimeEvidence,
    assessment: runtimeAssessment,
  },
  passed: runtimeAssessment.passed,
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
