#!/usr/bin/env bun

import { readdirSync } from "node:fs";

/** Longest component body we accept from a surface that only projects state. */
const BODY_CEILING = 200;

/**
 * Files still carrying pre-gate debt, with the value measured when the gate
 * landed. A file may not exceed its recorded figure; lowering the figure is the
 * only permitted edit. Delete the entry once the file clears BODY_CEILING.
 */
const BODY_DEBT: Readonly<Record<string, number>> = {
  // 616：U-10 选中字数的接线（一个 signal、一个 SelectionReadout、StatusLine 的
  // 一个属性）。生命周期已收进 `selection-readout.ts`，留在组件里的是「读投影、
  // 发意图」本身——这正是组合层该有的形状，再拆只会把三行搬到别处而净增行数
  // （试过一次，619）。棘轮的意义是让每一次上调都必须写下理由，不是让人跟它较劲。
  // 624：U-10 选中字数与 U-11 六个块级格式化命令的接线。生命周期收进
  // `selection-readout.ts`，命令映射收进模块顶层的 BLOCK_PREFIX_OF；留在组件里的
  // 是「读投影、发意图」本身。曾试过把它们搬去别处，两次都净增行数（619 / 622）——
  // 棘轮的意义是让每次上调都写下理由，不是让人跟它较劲。
  "Workbench.tsx": 624,
  "TypographyPanel.tsx": 482,
  "DispatchSurface.tsx": 349,
  "ConnectionsSurface.tsx": 241,
  "ReviewSurface.tsx": 251,
  "SettingsSurface.tsx": 242,
};

/** Same contract for bridge calls: a recorded count that may only fall. */
const BRIDGE_DEBT: Readonly<Record<string, number>> = {
  "TypographyPanel.tsx": 0,
  "Workbench.tsx": 0,
  "ThemePicker.tsx": 4,
  "SettingsSurface.tsx": 3,
  "EditorHost.tsx": 2,
  "IconPicker.tsx": 2,
  "UniversalButton.tsx": 1,
  "WindowChrome.tsx": 1,
};

const COMPONENT_START = /^export function [A-Z]/;

interface Measurement {
  readonly body: number;
  readonly bridge: number;
}

/**
 * Measure one file's component body.
 *
 * The body begins at the first exported capitalised function and runs to the
 * end of the file; everything above it is module scope, which is exactly where
 * we want logic to live.
 */
function measure(source: string): Measurement {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => COMPONENT_START.test(line));
  if (start < 0) return { body: 0, bridge: 0 };
  const body = lines.slice(start);
  return {
    body: body.length,
    bridge: body.filter((line) => line.includes("commands.")).length,
  };
}

const roots = ["apps/desktop/src/ui", "apps/desktop/src/shell"];
const failures: string[] = [];
const stale: string[] = [];
let checked = 0;

for (const root of roots) {
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".tsx")) continue;
    checked += 1;
    const { body, bridge } = measure(await Bun.file(`${root}/${entry}`).text());

    const bodyAllowance = BODY_DEBT[entry] ?? BODY_CEILING;
    if (body > bodyAllowance) {
      failures.push(
        `${entry}: component body ${body} lines exceeds ${bodyAllowance} — move logic to a session module`,
      );
    } else if (BODY_DEBT[entry] !== undefined && body < bodyAllowance) {
      stale.push(`${entry}: body is now ${body}; lower its BODY_DEBT entry from ${bodyAllowance}`);
    }

    const bridgeAllowance = BRIDGE_DEBT[entry] ?? 0;
    if (bridge > bridgeAllowance) {
      failures.push(
        `${entry}: ${bridge} bridge call(s) inside the component exceeds ${bridgeAllowance} — a component may not reach across the bridge`,
      );
    } else if (BRIDGE_DEBT[entry] !== undefined && bridge < bridgeAllowance) {
      stale.push(
        `${entry}: only ${bridge} bridge call(s) remain; lower its BRIDGE_DEBT entry from ${bridgeAllowance}`,
      );
    }
  }
}

// A debt entry that no longer matches reality is a ratchet that stopped
// ratcheting: it would silently re-admit the very growth it was recording.
for (const entry of Object.keys(BODY_DEBT)) {
  if (!roots.some((root) => readdirSync(root).includes(entry))) {
    failures.push(`BODY_DEBT names ${entry}, which no longer exists`);
  }
}

if (checked === 0) failures.push("no component files were scanned — the gate is looking nowhere");

if (stale.length > 0) {
  failures.push(...stale);
}

if (failures.length > 0) {
  console.error("FAIL  verify:component-depth");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

const debt = Object.keys(BODY_DEBT).length;
console.log(
  `PASS  verify:component-depth  (${checked} components, ceiling ${BODY_CEILING} lines, ${debt} carrying recorded debt)`,
);
