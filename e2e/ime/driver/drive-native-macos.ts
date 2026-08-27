#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const RELATIVE_RESULT_ROOT = "e2e/ime/results/native/macos";
const RESULT_ROOT = join(ROOT, RELATIVE_RESULT_ROOT);
const FIXTURE_ROOT = join(RESULT_ROOT, "fixture");
const EXECUTABLE = join(ROOT, "apps/native/zig-out/bin/refrain");
const DOCUMENT = join(FIXTURE_ROOT, "document.md");
const IDENTITY = join(RESULT_ROOT, "identity.json");
const MANIFEST = join(RESULT_ROOT, "run.json");
const JAPANESE_INPUT_SOURCE = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";

function command(argv: readonly string[], cwd = ROOT): string {
  const result = Bun.spawnSync([...argv], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || result.stderr.length > 0) {
    throw new Error(
      `${argv.join(" ")} failed (${result.exitCode})\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function appleScript(source: string): void {
  command(["osascript", "-e", source]);
}

function currentInputSource(): string {
  return command([
    "defaults",
    "read",
    "com.apple.HIToolbox",
    "AppleCurrentKeyboardLayoutInputSourceID",
  ]);
}

async function selectJapaneseInputSource(): Promise<void> {
  const enabled = command(["defaults", "read", "com.apple.HIToolbox", "AppleEnabledInputSources"]);
  if (!enabled.includes("com.apple.inputmethod.Kotoeri")) {
    throw new Error("The Japanese Kotoeri input source is not enabled on this macOS runner");
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (currentInputSource() === JAPANESE_INPUT_SOURCE) return;
    appleScript('tell application "System Events" to key code 49 using {control down}');
    await Bun.sleep(500);
  }
  throw new Error(`Could not activate ${JAPANESE_INPUT_SOURCE}`);
}

function nativeAutomation(args: readonly string[]): string {
  const result = Bun.spawnSync(["bun", "x", "native", "automate", ...args], {
    cwd: join(ROOT, "apps/native"),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = result.stderr.toString();
  if (
    result.exitCode !== 0 ||
    (stderr.length > 0 && !stderr.startsWith(`delivered ${args[0] ?? ""} -> `))
  ) {
    throw new Error(
      `native automate ${args.join(" ")} failed (${result.exitCode})\n${result.stdout.toString()}${stderr}`,
    );
  }
  return result.stdout.toString();
}

async function nativeSnapshot(
  publisherPid: number,
  name: string,
  required?: RegExp,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = nativeAutomation(["snapshot"]);
      if (
        last.includes("ready=true") &&
        new RegExp(`publisher_pid=${publisherPid}(?:\\s|$)`).test(last) &&
        last.includes("dispatch_errors=0") &&
        last.includes("gpu_nonblank=true") &&
        (required === undefined || required.test(last))
      ) {
        await writeFile(join(RESULT_ROOT, `${name}.snapshot.txt`), last, "utf8");
        return last;
      }
    } catch (error: unknown) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Native snapshot ${name} did not prove its state\n${last}`);
}

function frontmost(pid: number): void {
  appleScript(`
    tell application "System Events"
      set targetProcess to first process whose unix id is ${pid}
      set frontmost of targetProcess to true
    end tell
  `);
}

function clickInWindow(pid: number, x: number, y: number): void {
  appleScript(`
    tell application "System Events"
      set targetProcess to first process whose unix id is ${pid}
      set frontmost of targetProcess to true
      tell targetProcess
        set windowOrigin to position of front window
        click at {(item 1 of windowOrigin) + ${Math.round(x)}, (item 2 of windowOrigin) + ${Math.round(y)}}
      end tell
    end tell
  `);
}

function keystroke(value: string): void {
  appleScript(`tell application "System Events" to keystroke ${JSON.stringify(value)}`);
}

function keyCode(code: number): void {
  appleScript(`tell application "System Events" to key code ${code}`);
}

async function screenshot(name: string): Promise<void> {
  command(["screencapture", "-x", join(RESULT_ROOT, name)]);
}

async function startComposition(pid: number, name: string, romaji: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    keystroke(romaji);
    keyCode(49);
    try {
      return await nativeSnapshot(pid, name, /composition=\d+\.\.\d+[\s\S]*caret=\(/);
    } catch {
      keyCode(53);
      keyCode(51);
      await selectJapaneseInputSource();
    }
  }
  throw new Error("The Japanese OS input source did not create a Native composition");
}

async function cancelComposition(pid: number, name: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    keyCode(53);
    const snapshot = await nativeSnapshot(pid, name, /role=textbox[\s\S]*focused=true/);
    if (!snapshot.includes("composition=")) return;
  }
  throw new Error("Japanese composition stayed active after Escape");
}

async function screenshotSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");
}

await rm(RESULT_ROOT, { force: true, recursive: true });
await mkdir(FIXTURE_ROOT, { recursive: true });
await writeFile(DOCUMENT, "第一行\n\n第二行", "utf8");
await selectJapaneseInputSource();
command([
  "bun",
  "e2e/ime/capture-native-identity.ts",
  "--root",
  ROOT,
  "--executable",
  EXECUTABLE,
  "--output",
  IDENTITY,
]);

const child = Bun.spawn([EXECUTABLE], {
  cwd: join(ROOT, "apps/native"),
  env: {
    ...process.env,
    NATIVE_SDK_IME_EVIDENCE: "1",
    REFRAIN_NATIVE_ROOT: FIXTURE_ROOT,
    REFRAIN_NATIVE_DOCUMENT: "document.md",
    REFRAIN_NATIVE_APP_DB: join(FIXTURE_ROOT, "app.db"),
  },
  stdout: "pipe",
  stderr: "pipe",
});
const stdoutPromise = new Response(child.stdout).text();
const stderrPromise = new Response(child.stderr).text();

try {
  const initial = await nativeSnapshot(
    child.pid,
    "initial",
    /role=textbox name="RefRain manuscript"/,
  );
  frontmost(child.pid);
  const bounds = initial.match(
    /role=textbox name="RefRain manuscript" bounds=\(([-0-9.]+),([-0-9.]+) ([0-9.]+)x([0-9.]+)\)/,
  );
  const editorX = Number(bounds?.[1]);
  const editorY = Number(bounds?.[2]);
  if (!Number.isFinite(editorX) || !Number.isFinite(editorY)) {
    throw new Error("Native snapshot has no manuscript bounds");
  }

  let focused = false;
  for (const titlebarOffset of [28, 0, 44]) {
    clickInWindow(child.pid, editorX + 80, editorY + titlebarOffset + 20);
    await Bun.sleep(300);
    try {
      await nativeSnapshot(child.pid, `focus-${titlebarOffset}`, /role=textbox[\s\S]*focused=true/);
      focused = true;
      break;
    } catch {}
  }
  if (!focused) throw new Error("The Native manuscript did not focus from a real click");

  await startComposition(child.pid, "preedit", "kana");
  await screenshot("preedit.png");
  await cancelComposition(child.pid, "after-first-cancel");

  clickInWindow(child.pid, editorX + 80, editorY + 28 + 70);
  await Bun.sleep(300);
  await startComposition(child.pid, "movedPreedit", "nihongo");
  await screenshot("moved-preedit.png");
  keyCode(36);
  await nativeSnapshot(child.pid, "committed", /role=textbox[\s\S]*focused=true/);

  await startComposition(child.pid, "cancelPreedit", "tesuto");
  await cancelComposition(child.pid, "cancelled");

  for (const punctuation of [",", ".", "?", "!"]) {
    keystroke(punctuation);
    keyCode(36);
    await Bun.sleep(200);
  }
  const punctuation = await nativeSnapshot(
    child.pid,
    "punctuation",
    /role=textbox[\s\S]*focused=true/,
  );
  const save = punctuation.match(/widget @w1\/document#([0-9]+) role=button name="Save"/);
  const saveId = save?.[1];
  if (saveId === undefined) throw new Error("Native snapshot has no Save button");
  nativeAutomation(["widget-click", "document", saveId]);
  await Bun.sleep(500);
} finally {
  child.kill("SIGTERM");
  await child.exited;
  await writeFile(join(RESULT_ROOT, "runtime.stdout.log"), await stdoutPromise, "utf8");
  await writeFile(join(RESULT_ROOT, "runtime.stderr.log"), await stderrPromise, "utf8");
}

const preeditPath = join(RESULT_ROOT, "preedit.png");
const movedPath = join(RESULT_ROOT, "moved-preedit.png");
const manifest = {
  schemaVersion: 1,
  implementation: "native-rust-document-surface",
  platform: "macos",
  processId: child.pid,
  executablePath: relative(ROOT, EXECUTABLE),
  identityPath: `${RELATIVE_RESULT_ROOT}/identity.json`,
  runtimeLogPath: `${RELATIVE_RESULT_ROOT}/runtime.stderr.log`,
  finalDocumentPath: `${RELATIVE_RESULT_ROOT}/fixture/document.md`,
  resultPath: `${RELATIVE_RESULT_ROOT}/result.json`,
  snapshots: {
    preedit: `${RELATIVE_RESULT_ROOT}/preedit.snapshot.txt`,
    movedPreedit: `${RELATIVE_RESULT_ROOT}/movedPreedit.snapshot.txt`,
    committed: `${RELATIVE_RESULT_ROOT}/committed.snapshot.txt`,
    cancelPreedit: `${RELATIVE_RESULT_ROOT}/cancelPreedit.snapshot.txt`,
    cancelled: `${RELATIVE_RESULT_ROOT}/cancelled.snapshot.txt`,
    punctuation: `${RELATIVE_RESULT_ROOT}/punctuation.snapshot.txt`,
  },
  screenshots: {
    preedit: {
      path: `${RELATIVE_RESULT_ROOT}/preedit.png`,
      sha256: await screenshotSha256(preeditPath),
    },
    movedPreedit: {
      path: `${RELATIVE_RESULT_ROOT}/moved-preedit.png`,
      sha256: await screenshotSha256(movedPath),
    },
  },
  inputMethod: {
    locale: "ja-JP",
    identifier: JAPANESE_INPUT_SOURCE,
    installed: true,
    active: currentInputSource() === JAPANESE_INPUT_SOURCE,
    inputSource: "os",
  },
  expected: { committedText: "日本語", punctuation: "、。？！" },
};
await mkdir(dirname(MANIFEST), { recursive: true });
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
command([
  "bun",
  "e2e/ime/assert-native.ts",
  "--root",
  ROOT,
  "--manifest",
  `${RELATIVE_RESULT_ROOT}/run.json`,
]);
