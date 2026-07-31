#!/usr/bin/env bun
/**
 * Keep release publication small, native and causal.
 *
 * The main-branch gate owns source quality and real-window evidence. A tag is
 * pushed only after that workflow succeeds for the exact SHA. Repeating the
 * same suite in release.yml bought no additional evidence: it made publication
 * depend a second time on unrelated Chromium timing. The release workflow owns
 * only the shipping path.
 */

export {};

const WORKFLOW = ".github/workflows/release.yml";
const GATE_WORKFLOW = ".github/workflows/gate.yml";
const text = await Bun.file(WORKFLOW).text();
const gateText = await Bun.file(GATE_WORKFLOW).text();
const failures: string[] = [];

function requireText(needle: string, reason: string): void {
  if (!text.includes(needle)) failures.push(`缺少 ${needle}：${reason}`);
}

function forbid(pattern: RegExp, reason: string): void {
  if (pattern.test(text)) failures.push(`${pattern.source} 不应出现在 release.yml：${reason}`);
}

requireText('tags: ["v*"]', "发布只由不可混淆的版本 tag 触发");
requireText("bun run verify:release-version", "tag、Cargo、Tauri、workspace 版本必须一致");
requireText("bun x tauri build --bundles nsis", "Windows runner 必须生成真实 NSIS");
requireText("scriptc build scripts/release-assets.ts", "ScriptC 原生程序拥有公开资产策略");
requireText("target/release/release-assets.exe", "Windows runner 必须运行编译后的原生策略");
requireText("Require the exact pre-SBOM asset set", "发布前必须断言精确资产集合");
requireText("sha256sum --check SHA256SUMS", "上传前必须读回哈希");
requireText("needs: windows", "发布必须等待 Windows 原生包成功");

forbid(/workflow_dispatch:/, "没有 tag 的手工运行无法给出可靠版本身份");
forbid(/bun run gate/, "全仓门禁由 main 的 gate.yml 对同一 SHA 负责，不在 tag job 重跑");
forbid(/cargo clippy/, "同上；release 只验证 shipping path");
forbid(/cargo test/, "同上；release 只验证 shipping path");
forbid(/e2e:/, "窗口 E2E 属于 Windows main gate，不应以浏览器时序第二次卡住发布");

for (const [needle, reason] of [
  ["headless-evidence:", "headless 证据必须有独立 job"],
  ["continue-on-error: true", "Linux headless 夹具不得阻塞 main"],
  ["bun run evidence:headless", "独立 job 必须真的运行两项证据"],
  ["Writing slice against the real window", "Windows 真窗口写作路径仍须阻塞"],
  ["Review loop against the real window", "Windows 真窗口裁决路径仍须阻塞"],
  ["Dispatch loop against the real window", "Windows 真窗口派发路径仍须阻塞"],
] as const) {
  if (!gateText.includes(needle)) failures.push(`${GATE_WORKFLOW} 缺少 ${needle}：${reason}`);
}

if (failures.length > 0) {
  console.error("FAIL  verify:release-workflow: CI/CD 职责又混在一起");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log("PASS  verify:release-workflow  (main 管质量，tag 只打包；ScriptC 在发布路径)");
