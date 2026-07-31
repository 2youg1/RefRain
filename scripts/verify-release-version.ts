#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const files = {
  cargo: "Cargo.toml",
  cargoLock: "Cargo.lock",
  tauri: "apps/desktop/src-tauri/tauri.conf.json",
  desktop: "apps/desktop/package.json",
  editor: "packages/editor/package.json",
  bunLock: "bun.lock",
} as const;

const failures: string[] = [];

function requireMatch(text: string, pattern: RegExp, file: string, label: string): string {
  const value = text.match(pattern)?.[1];
  if (value === undefined) {
    failures.push(`${file}: 找不到 ${label}；门禁失去了检查对象`);
    return "<missing>";
  }
  return value;
}

function requireJsonVersion(text: string, file: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch (error: unknown) {
    failures.push(`${file}: JSON 无法解析：${String(error)}`);
    return "<invalid>";
  }
  failures.push(`${file}: 找不到字符串 version；门禁失去了检查对象`);
  return "<missing>";
}

const cargo = readFileSync(files.cargo, "utf8");
const authority = requireMatch(
  cargo,
  /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/,
  files.cargo,
  "[workspace.package].version",
);

const surfaces: Array<[string, string]> = [];
for (const file of [files.tauri, files.desktop, files.editor] as const) {
  surfaces.push([file, requireJsonVersion(readFileSync(file, "utf8"), file)]);
}

// bun.lock is JSONC (trailing commas), so parse the two workspace records by
// their exact names rather than pretending JSON.parse accepts its grammar.
const bunLock = readFileSync(files.bunLock, "utf8");
for (const [path, name] of [
  ["apps/desktop", "@refrain/desktop"],
  ["packages/editor", "@refrain/editor"],
] as const) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const version = requireMatch(
    bunLock,
    new RegExp(`"${escaped}"\\s*:\\s*\\{[\\s\\S]*?"version"\\s*:\\s*"([^"]+)"`),
    files.bunLock,
    `${name} workspace version`,
  );
  surfaces.push([`${files.bunLock}:${path}`, version]);
}

// Cargo.lock can contain unrelated dependencies at any version. Only the five
// local workspace package records are relevant.
const cargoLock = readFileSync(files.cargoLock, "utf8");
for (const name of [
  "refrain-core",
  "refrain-store",
  "refrain-host",
  "refrain-app",
  "refrain-desktop",
]) {
  const version = requireMatch(
    cargoLock,
    new RegExp(`name = "${name}"\\nversion = "([^"]+)"`),
    files.cargoLock,
    `${name} package version`,
  );
  surfaces.push([`${files.cargoLock}:${name}`, version]);
}

for (const [surface, version] of surfaces) {
  if (version !== authority) {
    failures.push(`${surface}: ${version}，权威 ${files.cargo} 是 ${authority}`);
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:release-version: 发布版本面发生漂移");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(`PASS  verify:release-version  (${authority}，${surfaces.length + 1} 个版本面一致)`);
