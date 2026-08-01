#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";

/** Longest component body we accept from a surface that only projects state. */
const BODY_CEILING = 200;

/**
 * Files still carrying pre-gate debt, with the value measured when the gate
 * landed. A file may not exceed its recorded figure; lowering the figure is the
 * only permitted edit. Delete the entry once the file clears BODY_CEILING.
 */
const BODY_DEBT: Readonly<Record<string, number>> = {
  // Shell composition; lifecycle, command mapping, and domain rules live in dedicated modules.
  // 596：原件面板（PDF 只读渲染）接线。**这是这条棘轮第一次上调**，所有者
  // 明确批准。上调的部分已经压到最小：面板本身的接线在模块级的
  // `SourceReference` 里（模块级函数不计入组件体），留在组件体内的只有无法
  // 外移的三处——命令目录多一个 `hasImportedSource` 判据、一个
  // `readSourceBytes` 绑定、以及把面板挂进舞台行。
  //
  // 记下这个数字的意义不变：它仍然只许下调。Workbench 拆分是既定重构，
  // 那次落地时这一行应当大幅回落而不是继续抬。
  "Workbench.tsx": 596,
  // Typography preview reads the same CSS variables as the manuscript.
  "TypographyPanel.tsx": 478,
  "DispatchSurface.tsx": 304,
  "ConnectionsSurface.tsx": 239,
  // Stale-proposal decisions and presentation live outside this composition surface.
  "ReviewSurface.tsx": 253,
  // 216：设置搜索接进界面的同时，分类标签栏也提成了模块级组件。加了一个功能
  // 而体积下降——搜索与标签栏都不是外壳的编排，是各自自成一体的一段。
  "SettingsSurface.tsx": 216,
};

/** Same contract for bridge calls: a recorded count that may only fall. */
const BRIDGE_DEBT: Readonly<Record<string, number>> = {
  "TypographyPanel.tsx": 0,
  "Workbench.tsx": 0,
  // 3：六项外观选择共用一条 `apply` 写入路径，不再每项各抄一份读值/写值/记错误。
  "ThemePicker.tsx": 3,
  "SettingsSurface.tsx": 3,
  "EditorHost.tsx": 2,
  "IconPicker.tsx": 1,

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
    const { body, bridge } = measure(readFileSync(`${root}/${entry}`, "utf8"));

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
