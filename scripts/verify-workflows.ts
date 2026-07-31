#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import { Glob } from "bun";

const WORKFLOWS = [
  ".github/workflows/gate.yml",
  ".github/workflows/ime-gate.yml",
  ".github/workflows/release.yml",
] as const;

const required = new Map<string, readonly string[]>([
  [
    WORKFLOWS[0],
    [
      "branches: [main, v0.2-rebuild]",
      "bun run gate",
      "bun scripts/prove-gates-bite.ts",
      "cargo fmt --all --check",
      "cargo clippy --workspace --all-targets -- -D warnings",
      "cargo test --workspace --all-targets",
      "bun run generate",
      "git diff --exit-code -- apps/desktop/src/generated",
      "bun x tauri build --debug --no-bundle",
    ],
  ],
  [WORKFLOWS[1], ["cron:", "windows-latest", "e2e/ime", "Install-Language", "-Shell wv2"]],
  [
    WORKFLOWS[2],
    [
      'tags: ["v*"]',
      "bun x tauri build --bundles nsis",
      "sha256sum --check SHA256SUMS",
      "gh release create",
    ],
  ],
]);

const failures: string[] = [];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const packageManifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
const packageManager = isRecord(packageManifest) ? packageManifest.packageManager : undefined;
const bunVersion =
  typeof packageManager === "string" ? packageManager.match(/^bun@(.+)$/)?.[1] : undefined;
if (bunVersion === undefined) failures.push("package.json has no exact Bun packageManager");

const cargoManifest = readFileSync("Cargo.toml", "utf8");
const rustVersion = cargoManifest.match(/^rust-version = "([^"]+)"$/m)?.[1];
if (rustVersion === undefined) failures.push("Cargo.toml has no workspace rust-version");

const files: string[] = [];
for await (const file of new Glob("*.yml").scan({ cwd: ".github/workflows" })) files.push(file);

const expectedNames = WORKFLOWS.map((path) => path.split("/").at(-1) ?? path).sort();
if (files.sort().join("\n") !== expectedNames.join("\n")) {
  failures.push(
    `workflow census differs: expected ${expectedNames.join(", ")}; found ${files.join(", ")}`,
  );
}

for (const path of WORKFLOWS) {
  const text = readFileSync(path, "utf8");
  for (const token of required.get(path) ?? []) {
    if (!text.includes(token)) failures.push(`${path} does not run or declare: ${token}`);
  }
  if (bunVersion !== undefined && !text.includes(`BUN_VERSION: ${bunVersion}`)) {
    failures.push(`${path} Bun version differs from package.json (${bunVersion})`);
  }
  if (rustVersion !== undefined && !text.includes(`RUST_VERSION: "${rustVersion}"`)) {
    failures.push(`${path} Rust version differs from Cargo.toml (${rustVersion})`);
  }
  if (!text.includes(`bun-version: \${{ env.BUN_VERSION }}`)) {
    failures.push(`${path} does not consume its Bun version authority`);
  }
  if (!text.includes(`toolchain: \${{ env.RUST_VERSION }}`)) {
    failures.push(`${path} does not consume its Rust version authority`);
  }

  for (const match of text.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)) {
    const action = match[1];
    const reference = match[2];
    if (
      action !== undefined &&
      !action.startsWith("./") &&
      !/^[0-9a-f]{40}$/.test(reference ?? "")
    ) {
      failures.push(`${path} uses mutable action reference ${action}@${reference ?? ""}`);
    }
  }

  for (const forbidden of [
    "electron",
    "packages/fs",
    "napi",
    "build:desktop",
    "electron-builder",
  ]) {
    if (text.toLowerCase().includes(forbidden))
      failures.push(`${path} still names legacy ${forbidden}`);
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:workflows");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:workflows  (${WORKFLOWS.length} workflows, pinned actions, Tauri commands)`,
);
