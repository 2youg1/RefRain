/**
 * 原生文档交互性能证据：起一个真窗，走作者真正走的那条路打开十万块的稿子，
 * 逐个动作量「输入到呈现」的延迟。
 *
 * **接上哪个功能**：`verify:native-document-performance`（`evidence:performance`
 * 的一条）。它是这套产品**唯一**的交互延迟证据——Rust 侧的规模测试量的是
 * 算法，只有这里量的是「按下一个键到屏幕上出现」。
 *
 * **在全局逻辑中负责什么**：起进程、准备语料、把子验收器的报告封成一份
 * 带来源的 JSON。判据本身在 `verify-native-document-performance.ts`。
 *
 * **为什么走 `REFRAIN_AUTOMATION_ROOT` 而不是环境变量直开**：产品早就不在
 * 启动时自动打开任何稿子了（`core.ts` 握手那段写着理由：首次启动根本没有
 * 文档，自动补发的 open 会被具名拒绝）。这条车道一直还在设 `REFRAIN_NATIVE_ROOT`
 * 与 `REFRAIN_NATIVE_DOCUMENT` 两个**没有任何读者**的名字，于是量的是一个
 * 空窗口——快照里根本没有正稿部件。现在它与 e2e 走同一条路：自动化项目
 * 通道回答「选哪个文件夹」，其余每一步都是作者的点击。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSourceExecutableIdentityUnchanged,
  collectSourceExecutableIdentity,
} from "./native-document-evidence-identity.ts";
import {
  SHARED_FIXTURE_BLOCKS,
  SHARED_FIXTURE_BYTES,
  SHARED_FIXTURE_DOCUMENT,
} from "./native-document-fixture.ts";
import {
  assertNativeRuntimeStderr,
  parseNativeInteractionReport,
} from "./native-document-performance-policy.ts";
import {
  nativeExecutablePath,
  requiresDisplay,
  windowEnvironment,
  windowPlatformLabel,
} from "./native-runtime-process.ts";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "apps/native");
const nativeCli = join(nativeDir, "node_modules/.bin/native");
const executable = nativeExecutablePath(nativeDir);
const verifier = join(root, "scripts/verify-native-document-performance.ts");
const automationDir = join(nativeDir, ".zig-cache/native-sdk-automation");
const runtimeDir = join(tmpdir(), `refrain-native-evidence-${process.pid}`);
const fixtureRoot = join(tmpdir(), `refrain-native-fixture-${process.pid}`);
const dataDir = join(tmpdir(), `refrain-native-data-${process.pid}`);

// 只有 Linux 的真窗需要一个 X11 显示。
const display = process.env.DISPLAY;
if (requiresDisplay() && (display === undefined || display.length === 0)) {
  throw new Error("native document performance evidence requires DISPLAY on this platform");
}

/*
 * 旧 DOM 编辑器随步骤 10 删除，所以对照组不再能当场跑出来。它最后一次实测的
 * 读数固定在这里，并且**标明是历史读数而不是本次测量**——同机、20 轮、
 * 10 万块、11,953,766 字节，mount p95 = 60.700000047683716 ms
 * （历史基线表随 ROADMAP 一并退役；读数本身保留在这里作为出处）。
 *
 * 这样做而不是删掉比较：拿掉对照组，「比旧路径快 20%」这条发布门槛就没有
 * 分母了。写死一个有出处的历史值，比悄悄改成只报绝对数诚实。
 */
const legacyReport = {
  implementation: "legacy-dom-editor",
  runs: 20,
  blocks: SHARED_FIXTURE_BLOCKS,
  fixtureBytes: SHARED_FIXTURE_BYTES,
  mountP95: 60.700000047683716,
  measuredAt: "2026-08-03, before the surface was deleted",
} as const;

/** 块与字节都对得上的一份稿子；对不上就抛，不悄悄凑。 */
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
for (const directory of [runtimeDir, fixtureRoot, dataDir]) {
  rmSync(directory, { force: true, recursive: true });
  mkdirSync(directory, { mode: 0o700, recursive: true });
}
writeFileSync(
  join(fixtureRoot, SHARED_FIXTURE_DOCUMENT),
  buildSharedDocumentFixture(SHARED_FIXTURE_BLOCKS, SHARED_FIXTURE_BYTES),
);

const runtime = Bun.spawn([executable], {
  cwd: nativeDir,
  env: {
    ...windowEnvironment(process.env, { display, runtimeDir }),
    // 自动化项目通道：只有「选哪个路径」这一步替作者回答，其余每一步
    // 都是真实点击（`NativeProjectPlatform`，与 `record-native-journals.ts` 同源）。
    REFRAIN_AUTOMATION_ROOT: fixtureRoot,
    REFRAIN_DATA_DIR: dataDir,
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
  for (const directory of [runtimeDir, fixtureRoot, dataDir]) {
    rmSync(directory, { force: true, recursive: true });
  }
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
const postRunIdentity = await collectSourceExecutableIdentity(root, executable);
assertSourceExecutableIdentityUnchanged(interactionReport.identity, postRunIdentity);
const report = {
  schemaVersion: 2,
  platform: windowPlatformLabel(display),
  legacy: legacyReport,
  interaction: interactionReport,
  postRunIdentity,
  passed: interactionReport.passed,
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
