#!/usr/bin/env bun

export {};

const config = await Bun.file("crates/refrain-store/src/config.rs").text();
const fonts = await Bun.file("apps/desktop/src-tauri/src/fonts.rs").text();
const bridge = await Bun.file("apps/desktop/src-tauri/src/lib.rs").text();
const bindings = await Bun.file("apps/desktop/src/generated/bindings.gen.ts").text();
const app = await Bun.file("apps/desktop/src/App.vue").text();
const projection = await Bun.file("apps/desktop/src/typography.ts").text();
const panel = await Bun.file("apps/desktop/src/shell/TypographyPanel.vue").text();
const editorHost = await Bun.file("apps/desktop/src/editor-host/EditorHost.vue").text();
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
  [app, "applyTypography(document.documentElement", "App does not apply the complete projection"],
  [projection, '"--manuscript-measure"', "the projection drops manuscript measure"],
  [projection, '"--paragraph-gap"', "the projection drops paragraph spacing"],
  [projection, '"--grid-period"', "the projection drops the baseline period"],
  [panel, "commands.listFonts()", "Settings does not load installed fonts"],
  [panel, 'kind: "setTypography"', "Settings does not write one complete typography value"],
  [panel, 'kind: "saveTypographyPreset"', "Settings cannot save a user preset"],
  [panel, 'kind: "removeTypographyPreset"', "Settings cannot remove a user preset"],
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
if (editor.includes('paragraph.style.margin = "0 0 1em"')) {
  failures.push("the editor kernel overrides the configured paragraph spacing");
}

if (failures.length > 0) {
  console.error("FAIL  verify:typography");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:typography  (9 files, Config v2, installed fonts, complete projection, presets)",
);
