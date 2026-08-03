#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

const rust = readFileSync("apps/desktop/src-tauri/src/lib.rs", "utf8");
const bindings = readFileSync("apps/desktop/src/generated/bindings.gen.ts", "utf8");
const debugBridge = readFileSync("apps/desktop/src/e2e/debug-bridge.ts", "utf8");
const application = readFileSync("crates/refrain-app/src/application.rs", "utf8");
// 「取得一个项目」搬进了 ProjectSession：选择器归 Rust 这条事实的权威随之移位。
const projectSession = readFileSync("apps/desktop/src/shell/project-session.ts", "utf8");
const documentSession = readFileSync("apps/desktop/src/shell/document-session.ts", "utf8");
const failures: string[] = [];

for (const [source, fact, failure] of [
  [
    rust,
    '#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]\n#[tauri::command]',
    "debug commands are not compile-time guarded",
  ],
  [rust, "refrain_commands![]", "the release registry is not the empty-debug command set"],
  [rust, "struct TauriProjectPlatform", "Rust has no Project chooser adapter"],
  [rust, ".project(&TauriProjectPlatform", "the desktop bypasses the Project use case"],
  [rust, "fn choose_import(", "Rust has no native import chooser"],
  [application, "ProjectInput::OpenDocument", "the Project use case cannot open a document"],
  [
    application,
    "ProjectInput::ChooseAndImportMaterial",
    "the Project use case cannot import a Material",
  ],
  [bindings, "project: (input: ProjectInput)", "release bindings have no Project group command"],
  [projectSession, "commands.project", "the app does not use the Rust Project use case"],
  [documentSession, "commands.project", "document opening bypasses the Project use case"],
] as const) {
  if (!source.includes(fact)) failures.push(failure);
}

for (const legacyProjectCommand of [
  "choose_and_adopt_root",
  "choose_and_create_project",
  "document_page",
  "document_search",
  "block_search",
  "delete_document",
  "set_disclosure",
  "open_document",
  "create_document",
  "choose_and_import_material",
  "choose_and_import_manuscript",
]) {
  if (rust.includes(`fn ${legacyProjectCommand}(`)) {
    failures.push(`the release Rust surface still exposes ${legacyProjectCommand}`);
  }
}
for (const legacyBinding of [
  "chooseAndAdoptRoot",
  "chooseAndCreateProject",
  "documentPage",
  "documentSearch",
  "blockSearch",
  "deleteDocument",
  "setDisclosure",
  "openDocument",
  "createDocument",
  "chooseAndImportMaterial",
  "chooseAndImportManuscript",
]) {
  if (
    bindings.includes(`\t${legacyBinding}: (`) ||
    projectSession.includes(`commands.${legacyBinding}`) ||
    documentSession.includes(`commands.${legacyBinding}`)
  ) {
    failures.push(`the release TypeScript surface still exposes ${legacyBinding}`);
  }
}

// 选择器只能有一个入口。上面几条证明 ProjectSession 用了它，这一条证明别人没有
// 绕过它自己开一个——单一入口才是这条不变量真正想要的东西。
const chooserOwners = new Set(["apps/desktop/src/shell/project-session.ts"]);
const walkFiles = (root: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
};

const chooserRoot = "apps/desktop/src";
for (const found of walkFiles(chooserRoot)) {
  const repositoryFile = found.replaceAll("\\", "/");
  if (!/\.(ts|tsx)$/.test(repositoryFile)) continue;
  if (!statSync(repositoryFile).isFile()) continue;
  if (chooserOwners.has(repositoryFile)) continue;
  const text = readFileSync(repositoryFile, "utf8");
  if (/commands\.chooseAnd/.test(text)) {
    failures.push(
      `${repositoryFile} opens a native chooser directly; that belongs to ProjectSession`,
    );
  }
}

for (const forbidden of [
  "injectFixtureProposal",
  "inject_fixture_proposal",
  "debugAdoptRoot",
  "debug_adopt_root",
  "debugCreateProject",
  "debug_create_project",
  "debugImportMaterial",
  "debug_import_material",
  "debugImportManuscript",
  "debug_import_manuscript",
  '__TAURI_INVOKE("adopt_root"',
  '__TAURI_INVOKE("create_project"',
  '__TAURI_INVOKE("import_material"',
  '__TAURI_INVOKE("import_manuscript"',
]) {
  if (bindings.includes(forbidden)) failures.push(`generated release bindings expose ${forbidden}`);
}

const expectedDebugBridge = [
  "debug_adopt_root",
  "debug_create_project",
  "debug_import_manuscript",
  "debug_import_material",
];
const debugBridgeCalls = [...debugBridge.matchAll(/\binvoke\("([^"]+)"/g)]
  .map((match) => match[1] ?? "")
  .sort();
if (debugBridgeCalls.join("\n") !== expectedDebugBridge.sort().join("\n")) {
  failures.push(`the E2E bridge command set drifted: ${debugBridgeCalls.join(", ")}`);
}

for (const supersededDesktopOwner of [
  "open_in_entry",
  "create_material_with_body",
  "import_material_at",
  "import_manuscript_at",
]) {
  if (rust.includes(`fn ${supersededDesktopOwner}`)) {
    failures.push(`the desktop still owns ${supersededDesktopOwner}`);
  }
}

if (failures.length === 0) {
  const result = spawnSync(
    "cargo",
    [
      "test",
      "-p",
      "refrain-store",
      "--test",
      "project",
      "adopting_scans_existing_manuscripts_into_rows",
      "--",
      "--exact",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    failures.push("the registered-document boundary test failed");
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:release-surface");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:release-surface  (3 targets; fixture and renderer-supplied path commands absent from release IPC)",
);
