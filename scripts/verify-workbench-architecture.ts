#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";

const workbench = readFileSync("apps/desktop/src/shell/Workbench.tsx", "utf8");
const quarters = readFileSync("apps/desktop/src/shell/quarters.ts", "utf8");
const reducer = readFileSync("apps/desktop/src/shell/workbench-state.ts", "utf8");
const panels = readFileSync("apps/desktop/src/shell/panel-stack.ts", "utf8");
const settings = readFileSync("apps/desktop/src/ui/SettingsSurface.tsx", "utf8");
const iconPicker = readFileSync("apps/desktop/src/ui/IconPicker.tsx", "utf8");
const icon = readFileSync("apps/desktop/src/shell/universal-icon.ts", "utf8");
const storeConfig = readFileSync("crates/refrain-store/src/config.rs", "utf8");
const bridge = readFileSync("apps/desktop/src-tauri/src/lib.rs", "utf8");
const bindings = readFileSync("apps/desktop/src/generated/bindings.gen.ts", "utf8");
const projectSession = readFileSync("apps/desktop/src/shell/project-session.ts", "utf8");
const projectStore = readFileSync("crates/refrain-store/src/project.rs", "utf8");
const projectCatalog = readFileSync("crates/refrain-store/src/project/catalog.rs", "utf8");
const failures: string[] = [];

// Components carry no scoped `<style>` block, so the layout facts below
// live inside Workbench.vue / SettingsSurface.vue. Solid components have no
// scoped style block: every rule moved to the central stylesheet. To keep the
// assertions as narrow as they were, read the stylesheet per *selector* rather
// than as one flat string — a rule that matches anywhere in the sheet would be
// a weaker check than the old per-component one.
const stylesheet = readFileSync("apps/desktop/src/styles/surfaces.css", "utf8");
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
    // 安全轴已离开 reducer（冲突归 DocumentSession 视图），state 只剩两条轴：
    // 场景与 hasDocument。reducer 因此不再需要泛型。
    "const [state, setState] = createSignal<WorkbenchState>(initialWorkbenchState());",
    "Workbench has no two-axis state authority",
  ],
  // `:class` → Solid `classList`.
  // Solid: `classList={{ receded: ... }}` must still fold the settings axis in.
  [workbench, 'reference()?.kind === "settings"', "Settings does not recede the Rail"],
  // Solid `<Show when={...}>`: Settings is mounted as a
  // Reference off the reducer's reference axis, not as its own stage。
  // 接线归模块级 SettingsReference，钉在那一处。
  [workbench, 'when={props.reference?.kind === "settings"}', "Settings is not a Reference"],
  [
    quarters,
    // Review alone owns the whole stage; settings must coexist with the manuscript.
    'return scene.stage === "review";',
    "takesWholeStage no longer names review as the one scene that takes the whole stage",
  ],
  [
    workbench,
    // The editor is hidden, not unmounted, so the instance survives.
    // Solid's `<Show>` unmounts, so the persistent editor is expressed the only
    // way that preserves the instance: the row stays rendered and the scenes
    // that take the whole stage hide it with `display: none` rather than
    // tearing it down.
    //
    // 判定本身已搬进 shell/quarters.ts 的 takesWholeStage——「谁占满舞台」是层的
    // 语义，不是渲染代码的知识。门禁跟着搬：断言组件问的是那个函数，而函数里
    // 那两个场景由下面一条单独钉住。
    //
    // 只写函数名不带 `({`：调用点传的是一个字面量还是一个已投影的 scene，
    // 与「组件有没有自己判断」无关。写死括号形状会在把实参提成变量时变红，
    // 而那次改动恰恰没有动这条规则——门禁该测的是它问了谁，不是它怎么写参数。
    "takesWholeStage(",
    "Settings or Review destroys the mounted editor instead of hiding it",
  ],
  // Two return
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
  // 换项目必须脱钩 hasDocument，否则逐句裁决与托付对着一份不存在的稿子开放。
  [reducer, 'case "projectChanged":', "project change does not detach the document axis"],
  // 「打开到哪一层」已从 reducer 移入 PanelStack：栈顶即屏幕，不再有第二处记录。
  // 断言那条规矩现在住的地方——点栈内层是回到它，而不是压一个副本。
  [panels, "findIndex", "the panel stack cannot return to a layer already open"],
  [panels, "slice(0, -1)", "the panel stack cannot step back one layer"],
  // 设置只留一个出口：「完成」调 onClosed。重复的「返回」已删（设计减法）。
  // 出口按钮接的是 onDone（由 Workbench 接到 onClosed）。
  [settings, "onDone: () => void", "Settings has no explicit return destination"],
  [settings, "完成", "Settings has no explicit return button"],
  [settings, "恢复本页默认", "Settings has no page-level default action"],
  [settings, "撤销本次调整", "Settings has no entry-snapshot restore action"],
  [settings, 'event.key !== "Escape"', "Escape does not leave Settings"],
  [settings, 'kind: "resetVisual"', "the appearance reset is not wired"],
  [settings, 'kind: "resetTypography"', "the typography reset is not wired"],
  [settings, 'kind: "restoreAppearance"', "the Settings-entry snapshot is not wired"],
  // Solid `onCleanup` owns teardown.
  //
  // 生命周期已搬进 shell/universal-icon.ts：取字节、跟随 config-changed、卸载后
  // 丢弃响应，此前在 UniversalButton 与 IconPicker 里各抄一遍**且已经漂开**
  // （一个先订阅后取，一个反过来，后者会漏掉两步之间到达的变更）。断言跟着搬到
  // 权威那一侧，并单独钉住两个组件不得再自己订阅。
  [icon, "onCleanup(", "the icon does not own its listener lifetime"],
  [icon, 'listen("config-changed"', "the icon no longer follows config changes"],
  // 两个组件都不该再自己订阅——订阅归模块。各持一份生命周期正是它们漂开的原因。
  [iconPicker, "universalIcon()", "IconPicker no longer takes its icon from the shared owner"],
  [storeConfig, "ResetVisual", "Config has no scoped visual reset"],
  [storeConfig, "ResetTypography", "Config has no scoped typography reset"],
  [storeConfig, "RestoreAppearance", "Config cannot restore the entry snapshot"],
  [
    bridge,
    // 翻译已搬进 `impl PreferencesChangeDto`，那里的变体写作 Self::。
    "Self::RestoreAppearance",
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

// The state object is never mutated in place, so the
// bypass check looked for assignments. A Solid signal can only be replaced via
// its setter, so the equivalent bypass is a `setState` call that does not route
// through the reducer.
for (const write of workbench.matchAll(/setState\(([\s\S]{0,160}?)\)\s*;/g)) {
  if (!write[1]?.includes("reduceWorkbench")) {
    failures.push("Workbench bypasses the state reducer with a raw setState");
  }
}
// Solid `createSignal(`: these axes must stay inside the reducer
// state, never become sibling signals. A `createMemo` derived from the reducer
// state is not a bypass, so only createSignal is banned.
for (const bypass of [
  /const\s+\[\s*conflict\b[\s\S]{0,40}?\]\s*=\s*createSignal/,
  /const\s+\[\s*annotationsOpen\b[\s\S]{0,48}?\]\s*=\s*createSignal/,
]) {
  if (bypass.test(workbench)) failures.push(`Workbench bypasses the state reducer: ${bypass}`);
}
if (existsSync("apps/desktop/src/shell/workbench-surface.ts")) {
  failures.push("the retired flat surface reducer still exists");
}

for (const state of ["reviewing", "dispatching", "connecting", "settings"]) {
  // The stage axis lives in one signal inside the reducer.
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
// Catalog SQL belongs to DocumentCatalog. Use signatures unique to that module.
for (const catalogSql of ["refreshed_documents", "fn documents_at", "LIMIT ?2"]) {
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
if (
  !/documentSearch: \(rootId: string, query: string, precision: SearchPrecision\)/.test(bindings)
) {
  failures.push("the generated search interface exposes more than root and query");
}
for (const retired of [
  "apps/desktop/src/shell/document-search-session.ts",
  "apps/desktop/test/document-search-session.test.ts",
]) {
  if (existsSync(retired)) failures.push(`retired catalog carrier still exists: ${retired}`);
}

// 栏脚取的是 `RailFoot` **整个函数体**，不是到第一个 `</div>` 为止。
//
// 此前那条非贪婪正则撞上内层 `</Show>` 之后的第一个 `</div>` 就收尾，于是
// 「连接」「设置」两颗按钮从来不在被检查的文本里——注入删除它们，门禁照样
// 绿。截取范围本身就是这道门禁能不能变红的前提。
const railFootStart = workbench.indexOf("function RailFoot(");
const railFootEnd = workbench.indexOf("\nfunction ", railFootStart + 1);
if (railFootStart < 0) failures.push("RailFoot is gone; the Rail's destinations cannot be checked");
const railFooterSource =
  railFootStart < 0
    ? ""
    : workbench.slice(railFootStart, railFootEnd < 0 ? undefined : railFootEnd);
// 注释先剥掉：一句解释为什么某个入口**不**在这里的注释，会把它自己的名字
// 带进来满足下面的断言，于是删掉那颗按钮门禁照样绿（实测发生过一次）。
const railFooter = railFooterSource
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

// 一词一义：批注 / KARA / 连接 / 设置 是栏脚的四个稳定目的地。
//
// 逐句裁决与托付台**不在这里**：它们只从信箱进入（v0.2.3 第一章）。作者
// 要去的是「有三单未读」，而栏脚给不出计数。这两条因此反向断言——它们
// 若回到栏脚，就是同一个目的地又有了两个入口。
// 取的是按钮之间的文本，不是某一种缩进写法：钉住「这里有哪些目的地」这个
// 性质，而不是今天的 JSX 恰好怎么换行。
const railLabels = new Set(
  [...railFooter.matchAll(/>\s*([^<>{}\s][^<>{}]*?)\s*</g)].map((match) => match[1]?.trim() ?? ""),
);
for (const label of ["批注", "KARA", "连接", "设置"]) {
  if (!railLabels.has(label))
    failures.push(`the Rail is missing the stable ${label} destination`);
}
for (const mailboxOnly of ["逐句裁决", "托付"]) {
  if (railFooter.includes(mailboxOnly))
    failures.push(`${mailboxOnly} has a second entrance in the Rail; the mailbox owns it`);
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
