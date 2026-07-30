#!/usr/bin/env bun

export {};

const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
const button = await Bun.file("apps/desktop/src/ui/UniversalButton.tsx").text();
const menu =
  (await Bun.file("apps/desktop/src/ui/UniversalMenu.tsx").text()) +
  (await Bun.file("apps/desktop/src/styles/surfaces.css").text());
const catalog = await Bun.file("apps/desktop/src/shell/workbench-commands.ts").text();
const shortcuts = await Bun.file("apps/desktop/src/shell/shortcuts.ts").text();
const focus = await Bun.file("apps/desktop/src/shell/command-focus.ts").text();
const icon = await Bun.file("apps/desktop/src/shell/universal-icon.ts").text();
const picker = await Bun.file("apps/desktop/src/ui/IconPicker.tsx").text();
const failures: string[] = [];

for (const [source, fact, failure] of [
  [workbench, "<UniversalButton", "Workbench does not mount the Universal Button"],
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
  // 焦点归还归 CommandFocus，并且它必须知道热区那条规矩：把焦点还给热区
  // 会让作者被关进开合循环。断言写在权威那一侧，不是外壳的变量名上。
  [focus, "isConnected", "focus can be returned to a node that already left the DOM"],
  [focus, "universal-button-zone", "returning focus to the hot zone can trap the author in a loop"],
  [workbench, "onChoose={executeCommand}", "the menu bypasses Workbench action ownership"],
  [button, "commands.universalIcon()", "the button does not consume the stored icon"],
  [button, "universal-hot-zone", "the button has no top-edge hot zone"],
  [button, "}, 240);", "the button does not use the 240 ms leave delay"],
  [menu, "width: min(520px", "the menu exceeds its declared width"],
  [menu, "padding: 12vh 24px", "the menu does not use the declared top offset"],
  [menu, "max-height: 62vh", "the menu exceeds its declared height"],
  [menu, "button:not(:disabled)", "Tab can escape the modal command menu"],
  [menu, "event.stopPropagation()", "menu shortcuts can leak into the writing surface"],
  [catalog, "slice(0, 9)", "an empty command query can exceed nine results"],
  [catalog, "先打开一篇手稿", "unavailable document actions have no next step"],
  [icon, "export function iconDataUrl", "the icon projection has no shared owner"],
  [picker, 'from "../shell/universal-icon"', "Settings duplicates the icon projection"],
  [button, 'from "../shell/universal-icon"', "the top-edge button duplicates the icon projection"],
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

console.log(
  "PASS  verify:universal-menu  (6 files, shared icon, top-edge trigger, Ctrl+K, fixed catalog)",
);
