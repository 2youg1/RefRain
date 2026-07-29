#!/usr/bin/env bun

export {};

const chrome = await Bun.file("apps/desktop/src/shell/WindowChrome.vue").text();
const workbench = await Bun.file("apps/desktop/src/shell/Workbench.vue").text();
const display = await Bun.file("apps/desktop/src-tauri/src/display.rs").text();
const scheduler = await Bun.file("apps/desktop/src/frame-scheduler.ts").text();
const capability = await Bun.file("apps/desktop/src-tauri/capabilities/default.json").json();
const config = await Bun.file("apps/desktop/src-tauri/tauri.conf.json").json();
const permissions = new Set<string>(capability.permissions);
const failures: string[] = [];

for (const [owner, method, permission] of [
  [chrome, "minimize()", "core:window:allow-minimize"],
  [chrome, "toggleMaximize()", "core:window:allow-toggle-maximize"],
  [chrome, "isMaximized()", "core:window:allow-is-maximized"],
  [chrome, "setFullscreen(", "core:window:allow-set-fullscreen"],
  [chrome, "isFullscreen()", "core:window:allow-is-fullscreen"],
  [workbench, "destroy()", "core:window:allow-destroy"],
] as const) {
  if (!owner.includes(method)) failures.push(`the owning surface does not call ${method}`);
  if (!permissions.has(permission)) failures.push(`capability is missing ${permission}`);
}
for (const label of ["最小化", "最大化窗口", "进入全屏", "关闭"]) {
  if (!chrome.includes(label)) failures.push(`WindowChrome is missing the ${label} control`);
}
if (!chrome.includes('event.key !== "F11"')) failures.push("F11 is not the fullscreen shortcut");
if (!workbench.includes("<WindowChrome")) failures.push("Workbench does not mount WindowChrome");
if (!workbench.includes('@close-requested="requestClose"')) {
  failures.push("the window close request bypasses Workbench");
}
const windowConfig = config.app?.windows?.[0];
if (windowConfig?.decorations !== false) failures.push("native decorations are not disabled");
if (windowConfig?.resizable !== true) failures.push("the window is not resizable");
if (typeof windowConfig?.minWidth !== "number" || windowConfig.minWidth < 880) {
  failures.push("the minimum window width is below 880 px");
}
for (const fact of ["EnumDisplaySettingsW", "dmDisplayFrequency", "FALLBACK_REFRESH_HZ"]) {
  if (!display.includes(fact)) failures.push(`display measurement is missing ${fact}`);
}
if (!scheduler.includes("requestAnimationFrame(flush)")) {
  failures.push("visual writes do not share requestAnimationFrame");
}
if (chrome.includes(" Hz"))
  failures.push("window chrome exposes internal refresh telemetry as UI text");

if (failures.length > 0) {
  console.error("FAIL  verify:window-chrome");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log("PASS  verify:window-chrome  (6 files, 6 controls, display profile, frame scheduler)");
