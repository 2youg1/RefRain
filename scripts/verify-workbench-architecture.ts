#!/usr/bin/env bun

export {};

const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
const reducer = await Bun.file("apps/desktop/src/shell/workbench-state.ts").text();
const settings = await Bun.file("apps/desktop/src/ui/SettingsSurface.tsx").text();
const iconPicker = await Bun.file("apps/desktop/src/ui/IconPicker.tsx").text();
const storeConfig = await Bun.file("crates/refrain-store/src/config.rs").text();
const bridge = await Bun.file("apps/desktop/src-tauri/src/lib.rs").text();
const bindings = await Bun.file("apps/desktop/src/generated/bindings.gen.ts").text();
const projectSession = await Bun.file("apps/desktop/src/shell/project-session.ts").text();
const projectStore = await Bun.file("crates/refrain-store/src/project.rs").text();
const projectCatalog = await Bun.file("crates/refrain-store/src/project/catalog.rs").text();
const failures: string[] = [];

// Vue SFCs carried their own `<style>` block, so the layout facts below used to
// live inside Workbench.vue / SettingsSurface.vue. Solid components have no
// scoped style block: every rule moved to the central stylesheet. To keep the
// assertions as narrow as they were, read the stylesheet per *selector* rather
// than as one flat string — a rule that matches anywhere in the sheet would be
// a weaker check than the old per-component one.
const stylesheet = await Bun.file("apps/desktop/src/styles/surfaces.css").text();
const cssRulesFor = (selectorFragment: string): string =>
  [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1]?.includes(selectorFragment))
    .map((rule) => rule[0])
    .join("\n");
const stageRules = cssRulesFor(".stage");
const settingsRules = cssRulesFor(".settings");

for (const [source, fact, message] of [
  [
    workbench,
    // Vue: `const workbench = ref<WorkbenchState<ConflictState>>(initialWorkbenchState())`.
    // Solid: one createSignal holding the same three-axis state value. The
    // conflict axis now lives on the DocumentSession view, so the generic
    // argument is `never` — the state authority itself is unchanged.
    "const [state, setState] = createSignal<WorkbenchState<never>>(initialWorkbenchState());",
    "Workbench has no three-axis state authority",
  ],
  // Vue: `:class="{ receded: railReceded || ... || surface.kind === 'settings' }"`.
  // Solid: `classList={{ receded: ... }}` must still fold the settings axis in.
  [workbench, 'reference()?.kind === "settings"', "Settings does not recede the Rail"],
  // Vue `v-if="..."` → Solid `<Show when={...}>`: Settings is mounted as a
  // Reference off the reducer's reference axis, not as its own stage.
  [workbench, 'when={reference()?.kind === "settings"}', "Settings is not a Reference"],
  [
    workbench,
    // Vue hid the editor with `v-show`, which keeps the instance mounted.
    // Solid's `<Show>` unmounts, so the persistent editor is expressed the only
    // way that preserves the instance: the row stays rendered and Settings /
    // Review hide it with `display: none` rather than tearing it down.
    'reference()?.kind === "settings" || state().stage === "review"',
    "Settings or Review destroys the mounted editor instead of hiding it",
  ],
  // Vue `@closed="returnToWriting"` → Solid `onClosed` props. Two return
  // destinations exist because the reducer has two axes: a Reference closes
  // back to its return context, a Stage returns to writing.
  [
    workbench,
    "onClosed={closeReference}",
    "a Reference can close without returning to its context",
  ],
  [
    workbench,
    'onClosed={() => openStage("writing")}',
    "a surface can close without returning to writing",
  ],
  [reducer, 'case "documentSelected":', "document selection does not restore writing"],
  [reducer, 'case "raiseSafety":', "external conflict is not owned by the state reducer"],
  [reducer, 'case "openReference":', "Reference return context has no transition owner"],
  // Vue interpolation `{{ props.returnLabel }}` → JSX expression container.
  [settings, "返回 {props.returnLabel", "Settings has no explicit return destination"],
  [settings, "恢复本页默认", "Settings has no page-level default action"],
  [settings, "撤销本次调整", "Settings has no entry-snapshot restore action"],
  [settings, 'event.key !== "Escape"', "Escape does not leave Settings"],
  [settings, 'kind: "resetVisual"', "the appearance reset is not wired"],
  [settings, 'kind: "resetTypography"', "the typography reset is not wired"],
  [settings, 'kind: "restoreAppearance"', "the Settings-entry snapshot is not wired"],
  // Vue `onBeforeUnmount` → Solid `onCleanup`: same teardown hook, same owner.
  [iconPicker, "onCleanup(", "IconPicker does not own its listener lifetime"],
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

// Vue mutated the state object in place (`workbench.value.stage = ...`), so the
// bypass check looked for assignments. A Solid signal can only be replaced via
// its setter, so the equivalent bypass is a `setState` call that does not route
// through the reducer.
for (const write of workbench.matchAll(/setState\(([\s\S]{0,160}?)\)\s*;/g)) {
  if (!write[1]?.includes("reduceWorkbench")) {
    failures.push("Workbench bypasses the state reducer with a raw setState");
  }
}
// Vue `ref(` → Solid `createSignal(`: these axes must stay inside the reducer
// state, never become sibling signals. A `createMemo` derived from the reducer
// state is not a bypass, so only createSignal is banned.
for (const bypass of [
  /const\s+\[\s*conflict\b[\s\S]{0,40}?\]\s*=\s*createSignal/,
  /const\s+\[\s*annotationsOpen\b[\s\S]{0,48}?\]\s*=\s*createSignal/,
]) {
  if (bypass.test(workbench)) failures.push(`Workbench bypasses the state reducer: ${bypass}`);
}
if (await Bun.file("apps/desktop/src/shell/workbench-surface.ts").exists()) {
  failures.push("the retired flat surface reducer still exists");
}

for (const state of ["reviewing", "dispatching", "connecting", "settings"]) {
  // Vue: `const reviewing = ref(false)`. Solid: `const [reviewing, setReviewing] = createSignal(false)`.
  if (
    new RegExp(`const\\s+\\[\\s*${state}\\b[\\s\\S]{0,48}?\\]\\s*=\\s*createSignal`).test(workbench)
  ) {
    failures.push(`Workbench restored the independent ${state} boolean`);
  }
}

for (const privateEditorFact of [
  "getSelection(",
  "p[data-block-id]",
  "wrapSelection",
  "range.deleteContents",
  "dispatchEvent(new Event",
]) {
  if (workbench.includes(privateEditorFact)) {
    failures.push(`Workbench reaches into the editor implementation: ${privateEditorFact}`);
  }
}

for (const leakedCatalogFact of [
  "commands.documentPage",
  "commands.documentSearch",
  "documentCursor",
  "documentTotal",
  "loadMoreDocuments",
]) {
  if (workbench.includes(leakedCatalogFact)) {
    failures.push(`Workbench owns the catalog implementation fact: ${leakedCatalogFact}`);
  }
}
if (!workbench.includes('from "./project-session"')) {
  failures.push("Workbench does not depend on the project catalog session");
}
for (const command of ["commands.documentPage", "commands.documentSearch"]) {
  if (!projectSession.includes(command)) failures.push(`ProjectSession does not own ${command}`);
}
if (/\bgeneration\s*(?::|[,)=])/.test(projectSession)) {
  failures.push("ProjectSession exposes or stores a bridge request generation");
}
if (!projectStore.includes("mod catalog;") || !projectStore.includes("pub use catalog::")) {
  failures.push("ProjectStore does not hide its catalog behind the project::catalog module");
}
for (const catalogSql of ["refreshed_documents", "WHERE path LIKE", "LIMIT ?2"]) {
  if (projectStore.includes(catalogSql)) {
    failures.push(`ProjectStore leaks catalog SQL: ${catalogSql}`);
  }
  if (!projectCatalog.includes(catalogSql)) {
    failures.push(`DocumentCatalog does not own: ${catalogSql}`);
  }
}
if (!projectCatalog.includes("limit.min(MAX_DOCUMENT_SEARCH_RESULTS)")) {
  failures.push("DocumentCatalog does not hard-limit search before rows cross the bridge");
}
if (!/documentSearch: \(rootId: string, query: string\)/.test(bindings)) {
  failures.push("the generated search interface exposes more than root and query");
}
for (const retired of [
  "apps/desktop/src/shell/document-search-session.ts",
  "apps/desktop/test/document-search-session.test.ts",
]) {
  if (await Bun.file(retired).exists())
    failures.push(`retired catalog carrier still exists: ${retired}`);
}

// `class="rail-foot"` is identical in Vue templates and Solid JSX, so the
// extraction is unchanged.
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

// Layout facts, read from the `.stage` / `.settings` rules of the central
// stylesheet now that Solid components carry no scoped `<style>` block.
if (!/height:\s*calc\([\s\S]*?overflow:\s*hidden/.test(stageRules)) {
  failures.push("Stage does not own the space between Chrome and StatusLine");
}
if (!/height:\s*100%[\s\S]*?overflow-y:\s*auto/.test(settingsRules)) {
  failures.push("Settings cannot scroll inside its Stage without covering StatusLine");
}

if (failures.length > 0) {
  console.error("FAIL  verify:workbench-architecture");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:workbench-architecture  (10 files, persistent editor, one bounded project catalog session)",
);
