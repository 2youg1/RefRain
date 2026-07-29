#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const rust = await Bun.file("apps/desktop/src-tauri/src/lib.rs").text();
const bindings = await Bun.file("apps/desktop/src/generated/bindings.gen.ts").text();
const debugBridge = await Bun.file("apps/desktop/src/e2e/debug-bridge.ts").text();
const workbench = await Bun.file("apps/desktop/src/shell/Workbench.vue").text();
const failures: string[] = [];

for (const [source, fact, failure] of [
  [
    rust,
    '#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]\n#[tauri::command]',
    "debug commands are not compile-time guarded",
  ],
  [rust, "refrain_commands![]", "the release registry is not the empty-debug command set"],
  [rust, "choose_and_adopt_root", "Rust has no native Root chooser"],
  [rust, "choose_and_create_project", "Rust has no native project-parent chooser"],
  [rust, "choose_and_import_material", "Rust has no native material chooser"],
  [rust, "confirm_and_import_dropped", "dropped paths have no native confirmation"],
  [rust, "open_registered_document(&path)", "open_document does not require a registered row"],
  [bindings, "chooseAndAdoptRoot: (kind: RootKind)", "release bindings have no Root chooser"],
  [bindings, "chooseAndCreateProject: (name: string)", "release bindings have no project chooser"],
  [
    bindings,
    "chooseAndImportMaterial: (rootId: string)",
    "release bindings have no material chooser",
  ],
  [bindings, "confirmAndImportDropped", "release bindings have no confirmed drop path"],
  [workbench, "commands.chooseAndAdoptRoot", "Workbench does not use the Rust-owned Root chooser"],
  [
    workbench,
    "commands.chooseAndImportMaterial",
    "Workbench does not use the Rust-owned source chooser",
  ],
] as const) {
  if (!source.includes(fact)) failures.push(failure);
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

for (const privateOwner of [
  "adopt_root_at",
  "create_project_at",
  "import_material_at",
  "import_manuscript_at",
]) {
  const at = rust.indexOf(`fn ${privateOwner}`);
  const prefix = at < 0 ? "" : rust.slice(Math.max(0, at - 120), at);
  if (at < 0) failures.push(`private path owner is missing: ${privateOwner}`);
  if (prefix.includes("#[tauri::command]")) {
    failures.push(`private path owner is exposed as IPC: ${privateOwner}`);
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
