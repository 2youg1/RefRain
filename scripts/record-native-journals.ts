// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 在真窗上录八条 e2e journal。
 *
 * **接上哪个功能**：会话录制。`NATIVE_SDK_SESSION_RECORD` 从第一条事件起把
 * 整场会话写进 journal，应用**干净退出**时封口；被信号杀掉的进程留不下结束
 * 标记，回放判 `JournalTruncated`（SDK `app_runner/root.zig` 的原话）。所以
 * 每条录制的最后一步永远是 `app.quit`，走最后一扇窗关闭的同一条收尾链。
 *
 * **在全局逻辑中负责什么**：把 `native-journals.ts` 那张表变成磁盘上的八个
 * 二进制。它是开发机上的动作，不进 CI——CI 只回放。同步不靠定长 sleep：
 * 每一步之后轮询快照，等到界面真的说出那句话为止，等不到就红在这一步。
 *
 * **能复用什么**：`REFRAIN_AUTOMATION_ROOT` 只替作者回答「选哪个文件夹」，
 * 其余每一步都是真实点击与真实键位，与性能证据车道同源。
 *
 * 用法：`bun run e2e:record`（全部八条）或 `bun run e2e:record files review`。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixtureDocuments,
  type JournalName,
  type JournalPlan,
  type JournalStep,
  journalNames,
  journalPath,
  journalPlans,
} from "./native-journals.ts";
import {
  nativeExecutablePath,
  requiresDisplay,
  windowEnvironment,
} from "./native-runtime-process.ts";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "apps/native");
const nativeCli = join(nativeDir, "node_modules/.bin/native");
const executable = nativeExecutablePath(nativeDir);
const automationDir = join(nativeDir, ".zig-cache/native-sdk-automation");
const snapshotFile = join(automationDir, "snapshot.txt");

/** 就绪、每步、退出的上限。取自实测（就绪约 3 秒、点开文档约 3 秒）的数倍余量。 */
const readyTimeoutMs = 60_000;
const stepTimeoutMs = 20_000;
const exitTimeoutMs = 15_000;

const display = process.env.DISPLAY;
if (requiresDisplay() && (display === undefined || display.length === 0)) {
  throw new Error("recording a journal needs a real window; this platform needs DISPLAY");
}

const requested = process.argv.slice(2);
for (const name of requested) {
  if (!journalNames.includes(name as JournalName)) {
    throw new Error(`unknown journal ${name}; known: ${journalNames.join(", ")}`);
  }
}
const selected: readonly JournalName[] =
  requested.length === 0 ? journalNames : (requested as readonly JournalName[]);

const build = spawnSync(nativeCli, ["build", ".", "--yes", "-Dautomation=true"], {
  cwd: nativeDir,
  encoding: "utf8",
});
if (build.status !== 0) {
  throw new Error(`native build -Dautomation=true failed (${build.status})\n${build.stderr}`);
}

/** 一步失败时说清楚：哪条、第几步、期望什么、当时界面上有什么。 */
class StepFailure extends Error {
  constructor(
    readonly journal: JournalName,
    readonly index: number,
    readonly step: JournalStep,
    detail: string,
  ) {
    super(`${journal} step ${index + 1} (${step.kind}): ${detail}`);
    this.name = "StepFailure";
  }
}

function automate(args: readonly string[]): { status: number; stderr: string } {
  const result = spawnSync(nativeCli, ["automate", ...args], {
    cwd: nativeDir,
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

/** 当前快照。应用把它写到自动化目录，按 UTF-8 读——中文名不过 stdout。 */
function snapshot(): string {
  if (automate(["snapshot"]).status !== 0) return "";
  try {
    return readFileSync(snapshotFile, "utf8");
  } catch {
    return "";
  }
}

async function pollUntil(
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; text: string }> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  for (;;) {
    text = snapshot();
    if (predicate(text)) return { ok: true, text };
    if (Date.now() >= deadline) return { ok: false, text };
    await Bun.sleep(250);
  }
}

/** 部件 id 按 role+name 现查。界面一变，红在「找不到这个按钮」，而不是点到别的东西。 */
function widgetId(text: string, role: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`#([0-9]+) role=${role} name="${escaped}"`))?.[1];
}

/** 这一屏上同 role 的部件都叫什么——改表时要看的就是这个。 */
function namesOfRole(text: string, role: string): string {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const found = line.match(new RegExp(`role=${role} name="([^"]*)"`))?.[1];
    if (found !== undefined && found.length > 0) names.add(found);
  }
  return [...names].join(" · ") || "(none)";
}

async function runStep(name: JournalName, index: number, step: JournalStep): Promise<void> {
  switch (step.kind) {
    case "expect": {
      const pattern = new RegExp(step.pattern);
      const { ok, text } = await pollUntil((seen) => pattern.test(seen), stepTimeoutMs);
      if (!ok) {
        throw new StepFailure(
          name,
          index,
          step,
          `never saw /${step.pattern}/ in ${text.length} bytes of snapshot`,
        );
      }
      return;
    }
    case "absent": {
      const pattern = new RegExp(step.pattern);
      const text = snapshot();
      if (pattern.test(text)) {
        throw new StepFailure(name, index, step, `/${step.pattern}/ is on screen and must not be`);
      }
      return;
    }
    case "click": {
      const { ok, text } = await pollUntil(
        (seen) => widgetId(seen, step.role, step.name) !== undefined,
        stepTimeoutMs,
      );
      if (!ok) {
        throw new StepFailure(
          name,
          index,
          step,
          `no ${step.role} named "${step.name}"; this screen has ${namesOfRole(text, step.role)}`,
        );
      }
      const id = widgetId(text, step.role, step.name);
      if (id === undefined)
        throw new StepFailure(name, index, step, "widget vanished between poll and click");
      const clicked = automate(["widget-click", "document", id]);
      if (clicked.status !== 0) {
        throw new StepFailure(name, index, step, `widget-click failed: ${clicked.stderr.trim()}`);
      }
      return;
    }
    case "type": {
      const { ok, text } = await pollUntil(
        (seen) => widgetId(seen, step.role, step.name) !== undefined,
        stepTimeoutMs,
      );
      const id = ok ? widgetId(text, step.role, step.name) : undefined;
      if (id === undefined) {
        throw new StepFailure(
          name,
          index,
          step,
          `no ${step.role} named "${step.name}"; this screen has ${namesOfRole(text, step.role)}`,
        );
      }
      const typed = automate(["widget-action", "document", id, "set_text", step.text]);
      if (typed.status !== 0) {
        throw new StepFailure(name, index, step, `set_text failed: ${typed.stderr.trim()}`);
      }
      return;
    }
    case "shortcut": {
      const fired = automate(["shortcut", step.id]);
      if (fired.status !== 0) {
        throw new StepFailure(
          name,
          index,
          step,
          `shortcut ${step.id} failed: ${fired.stderr.trim()}`,
        );
      }
      return;
    }
  }
}

interface Recorded {
  readonly name: JournalName;
  readonly events: number;
  readonly effects: number;
  readonly checkpoints: number;
  readonly bytes: number;
}

const sealedPattern =
  /session journal sealed: (\d+) events, (\d+) effect results, (\d+) checkpoints, \d+ screenshots, (\d+) bytes/;

async function record(name: JournalName, plan: JournalPlan): Promise<Recorded> {
  const file = journalPath(name);
  const fixtureRoot = join(tmpdir(), `refrain-journal-${name}-project`);
  const dataDir = join(tmpdir(), `refrain-journal-${name}-data`);
  for (const directory of [fixtureRoot, dataDir]) {
    rmSync(directory, { force: true, recursive: true });
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  for (const [document, text] of Object.entries(fixtureDocuments)) {
    writeFileSync(join(fixtureRoot, document), text);
  }
  rmSync(automationDir, { force: true, recursive: true });
  rmSync(file, { force: true });

  const app = Bun.spawn([executable], {
    cwd: nativeDir,
    env: {
      ...windowEnvironment(process.env, { display, runtimeDir: undefined }),
      REFRAIN_AUTOMATION_ROOT: fixtureRoot,
      REFRAIN_DATA_DIR: dataDir,
      NATIVE_SDK_SESSION_RECORD: file,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(app.stderr).text();

  try {
    const ready = await pollUntil((text) => text.length > 0, readyTimeoutMs);
    if (!ready.ok) throw new Error(`${name}: the window never answered a snapshot`);
    for (const [index, step] of plan.steps.entries()) await runStep(name, index, step);

    const quit = automate(["shortcut", "app.quit"]);
    if (quit.status !== 0) throw new Error(`${name}: app.quit failed: ${quit.stderr.trim()}`);
    const exited = await Promise.race([
      app.exited,
      Bun.sleep(exitTimeoutMs).then(() => "timeout" as const),
    ]);
    if (exited === "timeout") {
      throw new Error(`${name}: the app did not exit on app.quit; the journal would be truncated`);
    }
  } catch (error: unknown) {
    app.kill();
    await app.exited;
    rmSync(file, { force: true });
    throw error;
  } finally {
    for (const directory of [fixtureRoot, dataDir])
      rmSync(directory, { force: true, recursive: true });
  }

  const sealed = (await stderr).match(sealedPattern);
  if (sealed === null) {
    rmSync(file, { force: true });
    throw new Error(`${name}: the app exited without sealing the journal`);
  }
  return {
    name,
    events: Number(sealed[1]),
    effects: Number(sealed[2]),
    checkpoints: Number(sealed[3]),
    bytes: Number(sealed[4]),
  };
}

const failures: string[] = [];
const recorded: Recorded[] = [];
for (const name of selected) {
  const plan = journalPlans[name];
  try {
    const outcome = await record(name, plan);
    recorded.push(outcome);
    console.log(
      `ok    ${name.padEnd(12)} destination ${plan.destination} · ${outcome.events} events · ` +
        `${outcome.effects} effect results · ${outcome.checkpoints} checkpoints · ${outcome.bytes} bytes ` +
        `· replays ${plan.tier.mode}`,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(detail);
    console.error(`FAIL  ${name.padEnd(12)} ${detail}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL  recorded ${recorded.length}/${selected.length} journals`);
  process.exitCode = 1;
} else {
  console.log(`PASS  recorded ${recorded.length} journals; replay them with bun run e2e:journals`);
}
