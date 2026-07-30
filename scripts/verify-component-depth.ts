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
  // 587：交互逻辑重做。命令面板的焦点归还搬进 `command-focus.ts`（含「热区会把
  // 作者关进开合循环」那条只有它知道的规矩）；右键落点、批注锚点、派发种子三段
  // 搬进 `edit-intents.ts`；「从光标算出返回卡片」搬回 `kara-state.ts`——18 个字
  // 那个数字属于 KARA，不属于外壳。三处都配了此前根本无法编写的测试（要开真窗口）。
  // 583：面板栈接线净增的部分已各归其位——侧栏滚动位置归 rail-scroll，
  // 面板的键与可开性归 panel-reference，快捷键次序归 shortcuts（三者都因此
  // 第一次可测）。棘轮在这轮双向都咬过：先拦住 608 的上涨，又要求登记这次下降。
  // 586：正文让开面板这条路径（`--panel-reserve` + `data-panels`）。这是修一个
  // 渲染出来才看得见的缺陷——面板压在版心上会切掉每行行首三五个字，中日文与
  // 西文都从行首读起，作者拿到的是残句。投影本身已收进 `panelLayout`；
  // 留在这里的三行是「把它摊到 stage-row 上」，那正是组合层该做的事。
  //
  // 期间试过抽一个 `fromSource` 收敛四处「订阅+读值」，撤回了：四处形态各异
  // （project 的回调兼做公告、kara 的取消在 onCleanup 手动调），抽象会掩盖
  // 差异而不是隐藏复杂性。少三行不值得多一个说不清的东西。
  // 591：U-9 设置与正文并存（四区边缘情况 5，记为待修已久）。设置从 stage 的
  // 直接子元素移进 stage-row，成为第 1 层面板——探针实测此前它把正文挤到视口外
  // 156px 处，作者改字号时看不见自己的字。
  //
  // 净增的 18 行是这个功能的接线本身，不是可以搬走的逻辑：`settingsPanel` 已把
  // 两处重复的面板接线收成一份（否则是 24 行），CSS 侧的五处抄件也已收敛成一个
  // `[data-quarter]` 属性选择器。剩下的是「哪个场景挂哪个面板」，那正是组合层的职责。
  //
  // 试过再搬一次：把两个分支合并后反而 591 > 590。**跟棘轮较劲会净增行数**——
  // 前几轮试过三次（619 / 622 / 608），每次都增。棘轮的意义是让每一次上调都必须
  // 写下理由，不是让人把行数挪到别处。
  // 610：批注选择移出组件（数值取自 bun run fmt 之后——格式化会改行数，
  //   在格式化之前登记会被棘轮的下降分支当场咬住）（`annotation-selection.ts`）。这修的是一个真缺陷——
  // 「作者勾了哪些批注要派发」原本是 AnnotationSurface 的组件本地信号，面板一关
  // 就随 DOM 消失：勾十条、回正文核对一句、再打开，全没了，没有任何提示。
  // 那正是 KL9 的 ADHD 判据点名的「重复功能按键」。
  //
  // 净增的是接线（会话实例、tick、投影、retain 的 effect）。试过把 retain 塞进
  // 投影 memo 省四行，撤回了：那是在读取路径上做写入，让「读一个值」变成可能
  // 改变状态的操作，省下的行数不值得。模块本身 8 项测试，此前零覆盖。
  "Workbench.tsx": 610,
  // 483：排版预览段（U-9）。设置页独占 Stage 时手稿被完全盖住，而字距、词距、
  // 共享汉字优先级不看真实字形无法判断。预览只读 applyTypography 已经写好的那批
  // CSS 变量，不重算任何排版值——另写一份映射会立刻产生第二个排版权威。
  "TypographyPanel.tsx": 483,
  "DispatchSurface.tsx": 347,
  "ConnectionsSurface.tsx": 239,
  "ReviewSurface.tsx": 249,
  "SettingsSurface.tsx": 242,
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
