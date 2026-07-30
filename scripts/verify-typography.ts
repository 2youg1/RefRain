#!/usr/bin/env bun

export {};

const config = await Bun.file("crates/refrain-store/src/config.rs").text();
const fonts = await Bun.file("apps/desktop/src-tauri/src/fonts.rs").text();
const bridge = await Bun.file("apps/desktop/src-tauri/src/lib.rs").text();
const bindings = await Bun.file("apps/desktop/src/generated/bindings.gen.ts").text();
const app = await Bun.file("apps/desktop/src/App.tsx").text();
const appearance = await Bun.file("apps/desktop/src/shell/appearance.ts").text();
const projection = await Bun.file("apps/desktop/src/typography.ts").text();
const panel = await Bun.file("apps/desktop/src/ui/TypographyPanel.tsx").text();
// The panel became a projection: it renders a view and emits intents, while the
// bridge calls moved to the session that owns the manuscript setting. The four
// facts below are still facts about "Settings can do X" — they just have a new
// owner, so they are read there. Checking the panel would now check nothing.
const typographySession = await Bun.file("apps/desktop/src/shell/typography-session.ts").text();
const configTests = await Bun.file("crates/refrain-store/tests/config.rs").text();
const windowsE2e = await Bun.file("apps/desktop/e2e/writing-slice.ts").text();
// The Solid rewrite moved component `<style>` blocks into one stylesheet, so
// the editor's typography authority is now the component plus that sheet.
// Checking only the component would silently stop checking anything — but
// searching the whole sheet would be weaker than the old scoped `<style>`
// block, since any unrelated rule could satisfy the assertion. Read the sheet
// per selector so `.editor-host` facts must appear on `.editor-host` rules.
const stylesheet = await Bun.file("apps/desktop/src/styles/surfaces.css").text();
const cssRulesFor = (selectorFragment: string): string =>
  [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1]?.includes(selectorFragment))
    .map((rule) => rule[0])
    .join("\n");
const editorHost =
  (await Bun.file("apps/desktop/src/ui/EditorHost.tsx").text()) + cssRulesFor(".editor-host");
const editor = await Bun.file("packages/editor/src/index.ts").text();
const failures: string[] = [];

for (const [source, fact, failure] of [
  [config, "const CONFIG_VERSION: u32 = 2;", "Config does not declare the v2 schema"],
  [config, "pub typography: TypographyConfig", "Appearance has no complete typography owner"],
  [config, "pub typography_presets: Vec<TypographyPreset>", "Config does not own user presets"],
  [config, "SetTypography(TypographyConfig)", "Config cannot write typography as one value"],
  [config, "builtin_typography_presets", "the built-in presets have no domain owner"],
  [fonts, "load_system_fonts()", "the font catalog does not scan installed fonts"],
  [fonts, "OnceLock<Vec<FontFamilyDto>>", "the font catalog is not cached for the session"],
  [bridge, "fn list_fonts", "the bridge does not expose installed fonts"],
  [bridge, "spawn_blocking(move || catalog.list())", "font scanning can block the UI runtime"],
  [bridge, "fn list_builtin_typography_presets", "the bridge does not expose built-in presets"],
  [bindings, "listFonts: ()", "generated bindings omit the font catalog"],
  [bindings, "listBuiltinTypographyPresets: ()", "generated bindings omit built-in presets"],
  [
    bindings,
    '{ kind: "setTypography"; value: TypographyConfig }',
    "generated bindings split typography writes",
  ],
  [app, 'scheduleFrame("appearance"', "App does not frame-batch appearance projection"],
  // 投影已收进 shell/appearance.ts：一份 Config 一次落地（版面、面板、灯、排版
  // 必须一起写，否则作者会看见错位）。断言跟着权威走，不留在旧位置。
  [app, "applyAppearance(document.documentElement", "App does not apply the complete projection"],
  [appearance, "applyTypography(root", "the appearance projection drops typography"],
  [projection, '"--manuscript-measure"', "the projection drops manuscript measure"],
  [projection, '"--paragraph-gap"', "the projection drops paragraph spacing"],
  [projection, '"--grid-period"', "the projection drops the baseline period"],
  [typographySession, "commands.listFonts()", "Settings does not load installed fonts"],
  [
    typographySession,
    'kind: "setTypography"',
    "Settings does not write one complete typography value",
  ],
  [typographySession, 'kind: "saveTypographyPreset"', "Settings cannot save a user preset"],
  [typographySession, 'kind: "removeTypographyPreset"', "Settings cannot remove a user preset"],
  [
    configTests,
    "unsafe_font_names_and_duplicate_priority_are_refused_without_rewriting_config",
    "Config has no negative font-family or priority test",
  ],
  [windowsE2e, 'invoke("list_fonts")', "the Windows E2E never enumerates real system fonts"],
  [windowsE2e, 'clickButton("撤销本次调整")', "Settings entry undo has no real-window test"],
  [windowsE2e, 'clickButton("恢复本页默认")', "Settings page reset has no real-window test"],
  [windowsE2e, 'pressKey("")', "Settings Escape has no real-window test"],
  [editorHost, "var(--manuscript-weight", "the editor drops font weight"],
  [editorHost, "var(--manuscript-measure", "the editor drops manuscript measure"],
  [editorHost, "var(--paragraph-gap", "the editor drops paragraph spacing"],
  [editorHost, 'data-baseline-grid="on"', "the editor does not render the baseline aid"],
] as const) {
  if (!source.includes(fact)) failures.push(failure);
}

for (const label of [
  "字号",
  "字重",
  "行距",
  "字距",
  "词距",
  "显示缩放",
  "每行宽度",
  "首行缩进",
  "段落间距",
  "段落对齐",
  "顶部留白",
  "底部留白",
  "基线参考线",
]) {
  if (!panel.includes(label)) failures.push(`TypographyPanel omits the ${label} control`);
}

for (const removed of ["setFontFamily", "setFontPriority", "setTextSize", "setLineHeight"]) {
  if (panel.includes(removed))
    failures.push(`TypographyPanel restored the split ${removed} command`);
}
// Keep the convergence rather than trusting it to hold. A single `commands.`
// in the panel means logic started flowing back into the component, which is
// how this file grew to 629 lines the first time.
if (/\bcommands\./.test(panel)) {
  failures.push("TypographyPanel calls the bridge directly again; that belongs to its session");
}
if (!/new TypographySession\(/.test(panel)) {
  failures.push("TypographyPanel no longer routes through TypographySession");
}

if (editor.includes('paragraph.style.margin = "0 0 1em"')) {
  failures.push("the editor kernel overrides the configured paragraph spacing");
}

if (failures.length > 0) {
  console.error("FAIL  verify:typography");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:typography  (11 files, Config v2, real system fonts, negative inputs, Settings integration, complete projection, presets)",
);
