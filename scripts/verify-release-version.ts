#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const files = {
  cargo: "Cargo.toml",
  cargoLock: "Cargo.lock",
  appZon: "apps/native/app.zon",
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

/**
 * 工作区成员取自根 package.json 的 workspaces，不是手抄一份清单。
 *
 * 手抄的那份不会跟着新包长：`packages/typeset` 加进来的时候，它的版本与
 * 其余各处不一致，而这道门禁一声不响地通过了——因为它检查的是一张写死的
 * 名单，而新包不在名单上。域要取自权威。
 */
const rootManifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
const workspaceGlobs: readonly string[] =
  typeof rootManifest === "object" &&
  rootManifest !== null &&
  "workspaces" in rootManifest &&
  Array.isArray((rootManifest as { workspaces: unknown }).workspaces)
    ? ((rootManifest as { workspaces: string[] }).workspaces satisfies string[])
    : [];
if (workspaceGlobs.length === 0) {
  failures.push("package.json: 读不出 workspaces；这道门禁失去了它的检查域");
}

for (const file of workspaceGlobs.map((dir) => `${dir}/package.json`)) {
  surfaces.push([file, requireJsonVersion(readFileSync(file, "utf8"), file)]);
}

// app.zon 是 Native 打包读的那份版本号——步骤 10 之后它取代了 tauri.conf.json。
// ZON 不是 JSON，所以按字段名取，而不是 JSON.parse。
surfaces.push([
  files.appZon,
  requireMatch(
    readFileSync(files.appZon, "utf8"),
    /\.version\s*=\s*"([^"]+)"/,
    files.appZon,
    ".version",
  ),
]);

// build.zig.zon 也是 ZON。v0.2.5 发布时它仍写 0.2.4——它不在任何检查面上，
// 所以没有任何门禁看见。一面版本也不许再掉队。
surfaces.push([
  "apps/native/build.zig.zon",
  requireMatch(
    readFileSync("apps/native/build.zig.zon", "utf8"),
    /\.version\s*=\s*"([^"]+)"/,
    "apps/native/build.zig.zon",
    ".version",
  ),
]);

// bun.lock is JSONC (trailing commas), so parse the workspace records by their
// exact paths rather than pretending JSON.parse accepts its grammar.
const bunLock = readFileSync(files.bunLock, "utf8");
for (const path of workspaceGlobs) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const version = requireMatch(
    bunLock,
    new RegExp(`"${escaped}"\\s*:\\s*\\{[\\s\\S]*?"version"\\s*:\\s*"([^"]+)"`),
    files.bunLock,
    `${path} workspace version`,
  );
  surfaces.push([`${files.bunLock}:${path}`, version]);
}

// Cargo.lock can contain unrelated dependencies at any version. Only the local
// workspace package records are relevant — and which ones those are comes from
// Cargo.toml's members, for the same reason as above: a new crate must not be
// able to drift unnoticed because nobody remembered to add it to a list here.
const cargoLock = readFileSync(files.cargoLock, "utf8");
const memberBlock = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
const crateNames = [...memberBlock.matchAll(/"([^"]+)"/g)]
  .map((match) => match[1] ?? "")
  .filter((dir) => dir !== "")
  // 包名读自各成员自己的 Cargo.toml，不从目录名推：`apps/desktop/src-tauri`
  // 里住的是 `refrain-desktop`，按目录名去 Cargo.lock 里找会找不到，而
  // 「找不到」与「版本对不上」在输出里长得一样。
  .map(
    (dir) => readFileSync(`${dir}/Cargo.toml`, "utf8").match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "",
  )
  .filter((name) => name !== "");
if (crateNames.length === 0) {
  failures.push("Cargo.toml: 读不出 workspace members；Rust 那半失去了检查域");
}
for (const name of crateNames) {
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
