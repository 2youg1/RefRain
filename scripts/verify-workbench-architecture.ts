#!/usr/bin/env bun

export {};

const workbench = await Bun.file("apps/desktop/src/shell/Workbench.vue").text();
const reducer = await Bun.file("apps/desktop/src/shell/workbench-surface.ts").text();
const settings = await Bun.file("apps/desktop/src/shell/SettingsSurface.vue").text();
const iconPicker = await Bun.file("apps/desktop/src/shell/IconPicker.vue").text();
const storeConfig = await Bun.file("crates/refrain-store/src/config.rs").text();
const bridge = await Bun.file("apps/desktop/src-tauri/src/lib.rs").text();
const bindings = await Bun.file("apps/desktop/src/generated/bindings.gen.ts").text();
const failures: string[] = [];

for (const [source, fact, message] of [
  [
    workbench,
    'const surface = ref<WorkbenchSurface>({ kind: "writing" });',
    "Workbench has no single surface authority",
  ],
  [workbench, "surface.kind === 'settings'", "Settings does not recede the Rail"],
  [workbench, "v-if=\"surface.kind === 'settings'\"", "Settings is not a Stage-level surface"],
  [workbench, '@closed="returnToWriting"', "a surface can close without returning to writing"],
  [reducer, 'case "documentSelected":', "document selection does not restore writing"],
  [settings, "返回 {{ props.returnLabel }}", "Settings has no explicit return destination"],
  [settings, "恢复本页默认", "Settings has no page-level default action"],
  [settings, "撤销本次调整", "Settings has no entry-snapshot restore action"],
  [settings, 'event.key !== "Escape"', "Escape does not leave Settings"],
  [settings, 'kind: "resetVisual"', "the appearance reset is not wired"],
  [settings, 'kind: "resetTypography"', "the typography reset is not wired"],
  [settings, 'kind: "restoreAppearance"', "the Settings-entry snapshot is not wired"],
  [iconPicker, "onBeforeUnmount", "IconPicker does not own its listener lifetime"],
  [iconPicker, "stopConfig?.()", "IconPicker leaks its config-changed listener"],
  [storeConfig, "ResetVisual", "Config has no scoped visual reset"],
  [storeConfig, "ResetTypography", "Config has no scoped typography reset"],
  [storeConfig, "RestoreAppearance", "Config cannot restore the entry snapshot"],
  [
    bridge,
    "PreferencesChangeDto::RestoreAppearance",
    "the Tauri bridge drops snapshot restoration",
  ],
  [
    bindings,
    '{ kind: "restoreAppearance"; value: AppearanceConfig }',
    "generated bindings omit snapshot restoration",
  ],
] as const) {
  if (!source.includes(fact)) failures.push(message);
}

for (const state of ["reviewing", "dispatching", "connecting", "settings"]) {
  if (new RegExp(`const\\s+${state}\\s*=\\s*ref`).test(workbench)) {
    failures.push(`Workbench restored the independent ${state} boolean`);
  }
}

const railFooter = workbench.match(/<div class="rail-foot">([\s\S]*?)<\/div>/)?.[1] ?? "";
for (const label of ["Review", "派发", "连接", "设置"]) {
  if (!railFooter.includes(label))
    failures.push(`the Rail is missing the stable ${label} destination`);
}
if (railFooter.includes("收起")) failures.push("a Rail destination changes its label to 收起");

for (const leakedTerm of ["Reference", "本机 Config", "Universal Button"]) {
  if (settings.includes(leakedTerm))
    failures.push(`Settings exposes the implementation term: ${leakedTerm}`);
}

if (!/\.stage\s*\{[\s\S]*?height:\s*calc\([\s\S]*?overflow:\s*hidden/.test(workbench)) {
  failures.push("Stage does not own the space between Chrome and StatusLine");
}
if (!/\.settings\s*\{[\s\S]*?height:\s*100%[\s\S]*?overflow-y:\s*auto/.test(settings)) {
  failures.push("Settings cannot scroll inside its Stage without covering StatusLine");
}

if (failures.length > 0) {
  console.error("FAIL  verify:workbench-architecture");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:workbench-architecture  (7 files, one surface state, stable Rail, reversible Settings)",
);
