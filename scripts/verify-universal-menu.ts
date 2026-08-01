#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const workbench = readFileSync("apps/desktop/src/shell/Workbench.tsx", "utf8");
const menu =
  readFileSync("apps/desktop/src/ui/UniversalMenu.tsx", "utf8") +
  readFileSync("apps/desktop/src/styles/surfaces.css", "utf8");
const catalog = readFileSync("apps/desktop/src/shell/workbench-commands.ts", "utf8");
const shortcuts = readFileSync("apps/desktop/src/shell/shortcuts.ts", "utf8");
const focus = readFileSync("apps/desktop/src/shell/command-focus.ts", "utf8");
const icon = readFileSync("apps/desktop/src/shell/universal-icon.ts", "utf8");
const picker = readFileSync("apps/desktop/src/ui/IconPicker.tsx", "utf8");
const failures: string[] = [];

for (const [source, fact, failure] of [
  [workbench, "<UniversalMenu", "Workbench does not mount the Universal Menu"],
  // 快捷键的分发已归 shortcuts.ts：断言写在权威那一侧，不写在外壳的字面上。
  [shortcuts, 'key === "k"', "Ctrl+K does not open the menu"],
  // The open shortcut lives in Workbench; the menu owns the matching close.
  [menu, 'event.key.toLocaleLowerCase() === "k"', "Ctrl+K does not close the menu"],
  [
    workbench,
    'window.addEventListener("keydown", onKeydown)',
    "Workbench shortcuts disappear when focus falls back to the window",
  ],
  [shortcuts, "isComposing", "Ctrl+K can intercept IME composition"],
  [workbench, "new CommandFocus(", "the menu does not route focus through CommandFocus"],
  // 会让作者被关进开合循环。断言写在权威那一侧，不是外壳的变量名上。
  [focus, "isConnected", "focus can be returned to a node that already left the DOM"],
  [workbench, "onChoose={executeCommand}", "the menu bypasses Workbench action ownership"],
  [icon, "commands.universalIcon()", "the icon owner no longer reads the stored icon"],
  [menu, "width: min(520px", "the menu exceeds its declared width"],
  [menu, "padding: 12vh 24px", "the menu does not use the declared top offset"],
  [menu, "max-height: 62vh", "the menu exceeds its declared height"],
  [menu, "button:not(:disabled)", "Tab can escape the modal command menu"],
  [menu, "event.stopPropagation()", "menu shortcuts can leak into the writing surface"],
  [catalog, "slice(0, 9)", "an empty command query can exceed nine results"],
  [catalog, "先打开一篇手稿", "unavailable document actions have no next step"],
  [icon, "export function iconDataUrl", "the icon projection has no shared owner"],
  [picker, 'from "../shell/universal-icon"', "Settings duplicates the icon projection"],
] as const) {
  if (!source.includes(fact)) failures.push(failure);
}
if (catalog.includes('"open-agents"')) {
  failures.push("the catalog duplicates Connections as a second Agent destination");
}

const declaredGroups = [
  '"continue"',
  '"project"',
  '"work"',
  '"reference"',
  '"agents"',
  '"appearance"',
  '"application"',
];
let previous = -1;
for (const group of declaredGroups) {
  const position = catalog.indexOf(group);
  if (position <= previous) failures.push(`command group order is unstable at ${group}`);
  previous = position;
}

if (failures.length > 0) {
  console.error("FAIL  verify:universal-menu");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

// 顶缘热区（UniversalButton）已删：隐形热区违反「入口必须可见」，命令面板的
// 入口是 Ctrl+K 与栏脚。命令入口放进栏脚是场所树重写（ToDo 5）的一部分。
console.log("PASS  verify:universal-menu  (shared icon, Ctrl+K, fixed catalog)");
