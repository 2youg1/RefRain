#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/release.yml";
const GATE_WORKFLOW = ".github/workflows/gate.yml";
const text = readFileSync(WORKFLOW, "utf8");
const gateText = readFileSync(GATE_WORKFLOW, "utf8");
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
requireText('SCRIPTC_VERSION: "0.0.21"', "发布路径必须锁定已核实的 ScriptC 版本");
requireText(
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "ScriptC 的 Node 运行时必须显式安装并固定 action commit",
);
requireText("node-version: $" + "{{ env.NODE_VERSION }}", "Node 版本必须由 workflow 环境统一指定");
requireText("Get-Command clang", "Windows runner 必须显式检查 ScriptC 编译器后端");
requireText("scriptc build scripts/release-assets.ts", "ScriptC 原生程序拥有公开资产策略");
requireText("target/release/release-assets.exe", "Windows runner 必须运行编译后的原生策略");
requireText("Require the exact pre-SBOM asset set", "发布前必须断言精确资产集合");
requireText("/tmp/release-assets-policy embed-sbom", "公开 manifest 必须内嵌 SPDX SBOM");
requireText("rm release-assets/refrain-windows-x64.spdx.json", "临时 SBOM 不得成为第四个公开资产");
requireText("sha256sum --check SHA256SUMS", "上传前必须读回哈希");
requireText("release-assets/refrain-windows-x64-setup.exe", "必须显式上传唯一安装包");
requireText("release-assets/release-manifest.json", "必须显式上传内嵌 SBOM 的 manifest");
requireText("release-assets/SHA256SUMS", "必须显式上传哈希清单");
for (const document of [
  "README.md",
  "docs/AGENTS.md",
  "docs/ARCHITECTURE.md",
  "docs/CONTRIBUTING.md",
  "docs/ROADMAP.md",
  "docs/SKILL.md",
  "LICENSE",
]) {
  requireText(`blob/$GITHUB_REF_NAME/${document}`, `${document} 的发布链接必须固定到该 tag`);
}
requireText("--verify-tag", "发布命令不得隐式创建指向默认分支的新 tag");
requireText("needs: windows", "发布必须等待 Windows 原生包成功");

forbid(/workflow_dispatch:/, "没有 tag 的手工运行无法给出可靠版本身份");
forbid(/bun run gate/, "全仓门禁由 main 的 gate.yml 对同一 SHA 负责，不在 tag job 重跑");
forbid(/cargo clippy/, "同上；release 只验证 shipping path");
forbid(/cargo test/, "同上；release 只验证 shipping path");
forbid(/e2e:/, "窗口 E2E 属于 Windows main gate，不应以浏览器时序第二次卡住发布");
forbid(/release-assets\/\*\.(?:exe|json)/, "通配上传会静默增加公开资产");
forbid(/scriptc@0\.0\.17/, "旧 ScriptC 版本不得重返发布路径");

for (const [needle, reason] of [
  ["headless-evidence:", "headless 证据必须有独立 job"],
  ["continue-on-error: true", "Linux headless 夹具不得阻塞 main"],
  ["bun run evidence:headless", "独立 job 必须真的运行两项证据"],
  ["bun x playwright install --with-deps chromium", "Linux browser 证据必须安装可执行文件与系统库"],
  ["performance-evidence:", "共享 runner 性能数必须有独立 job"],
  ["non-blocking Windows performance evidence", "性能证据应在产品目标平台采集"],
  ["bun run evidence:performance", "性能 job 必须真的运行性能测试"],
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
