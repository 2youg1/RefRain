/**
 * 回放全部八条 e2e journal，并把报告落成证据。
 *
 * **接上哪个功能**：CI 的 Windows 端到端一步（`gate.yml`）与本机的
 * `bun run e2e:journals`。回放走 null 平台——没有窗、没有定时器、没有效果，
 * journal 就是世界（SDK `app_runner/root.zig` 的原话）。真窗在**录制**那一侧。
 *
 * **在全局逻辑中负责什么**：一条命令判八条。逐条判退出码与报告行，任何一条
 * 红整条车道红；证据写进 `target/e2e-evidence`——那条上传步骤在 CI 里存在很久
 * 却从来没有人写过内容。
 *
 * **能复用什么**：分档来自 `native-journals.ts` 的表，不是这里的第二份清单；
 * 一条 journal 能不能对指纹，改表即改。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROTOCOL_VERSION } from "../apps/native/src/generated/protocol.ts";
import {
  type JournalName,
  journalNames,
  journalPath,
  journalPlans,
  recordedProtocolVersions,
} from "./native-journals.ts";
import { nativeExecutablePath } from "./native-runtime-process.ts";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "apps/native");
const nativeCli = join(nativeDir, "node_modules/.bin/native");
const evidenceDir = join(root, "target/e2e-evidence");

/** SDK 的报告行；解析它而不是只看退出码——「回放了 0 条事件」也是红。 */
const reportPattern =
  /session replay: (\d+) events, (\d+) effect results fed \((\d+) regenerated\), (\d+) fingerprint checkpoints, (\d+) screenshot marks/;

interface Replayed {
  readonly name: JournalName;
  readonly destination: number;
  readonly mode: string;
  readonly events: number;
  readonly effectsFed: number;
  readonly effectsRegenerated: number;
  readonly checkpointsVerified: number;
  readonly screenshotsVerified: number;
}

const executable = relative(nativeDir, nativeExecutablePath(nativeDir)).replaceAll("\\", "/");
const failures: string[] = [];
const replayed: Replayed[] = [];

for (const name of journalNames) {
  const plan = journalPlans[name];
  const flag = plan.tier.mode === "verify" ? "--verify" : "--no-verify";
  // 先问录制能不能判这个二进制。回放把录制的答复当世界喂回去，核心拿
  // 编译进去的协议版本逐字比；版本不同时每一条答复都走「坏契约」分支，
  // 而指纹依旧能对上——车道会在没在判产品的情况下报绿。实测于协议
  // 4→5：八条全绿。陈旧的录制必须在这里具名地红，而不是静默地绿。
  const recorded = recordedProtocolVersions(name);
  const stale = recorded.filter((version) => version !== PROTOCOL_VERSION);
  if (stale.length > 0) {
    const detail =
      `recorded under protocol ${stale.join(", ")}, this binary speaks ${PROTOCOL_VERSION}; ` +
      "re-record with `bun run e2e:record`";
    failures.push(`${name}: ${detail}`);
    console.error(`FAIL  ${name.padEnd(12)} ${detail}`);
    continue;
  }
  const child = Bun.spawn(
    [nativeCli, "automate", "replay", journalPath(name), flag, "--", executable],
    { cwd: nativeDir, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stderr}${stdout}`;
  const report = output.match(reportPattern);
  if (exitCode !== 0 || report === null) {
    const detail = output.trim().split("\n").slice(-6).join("\n      ");
    failures.push(`${name}: replay exited ${exitCode}\n      ${detail}`);
    console.error(`FAIL  ${name.padEnd(12)} exit ${exitCode}\n      ${detail}`);
    continue;
  }
  const events = Number(report[1]);
  if (events === 0) {
    failures.push(`${name}: replayed zero events`);
    console.error(`FAIL  ${name.padEnd(12)} replayed zero events`);
    continue;
  }
  const outcome: Replayed = {
    name,
    destination: plan.destination,
    mode: plan.tier.mode,
    events,
    effectsFed: Number(report[2]),
    effectsRegenerated: Number(report[3]),
    checkpointsVerified: Number(report[4]),
    screenshotsVerified: Number(report[5]),
  };
  replayed.push(outcome);
  console.log(
    `ok    ${name.padEnd(12)} destination ${outcome.destination} · ${outcome.events} events · ` +
      `${outcome.effectsFed} effect results fed · ${outcome.checkpointsVerified} checkpoints verified ` +
      `· ${flag}`,
  );
}

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(
  join(evidenceDir, "journals.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      platform: process.platform,
      journals: replayed,
      blocked: Object.entries(journalPlans)
        .filter(([, plan]) => plan.tier.mode === "no-verify")
        .map(([name, plan]) => ({
          name,
          blockedBy: plan.tier.mode === "no-verify" ? plan.tier.blockedBy : "",
        })),
      failures,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  console.error(
    `FAIL  e2e journals: ${failures.length} of ${journalNames.length} refused to replay`,
  );
  process.exitCode = 1;
} else {
  const verified = replayed.reduce((sum, one) => sum + one.checkpointsVerified, 0);
  console.log(
    `PASS  e2e journals: ${replayed.length}/${journalNames.length} replayed, ${verified} fingerprint checkpoints verified`,
  );
}
