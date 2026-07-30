/**
 * 层的唯一权威。
 *
 * shell/strata.ts 规定四层，样式表只准引用变量。在此之前十五个 z-index 散在
 * surfaces.css 各处，每个单看都对，合起来没有一处说明谁在谁上面——`.panel-spine`
 * 是 9 而面板是 10，书脊被面板压着，与「多层书脊在四区之上」正好相反，而那个矛盾
 * 在任何一处都读不出来，只有把十五个数字排成一列才看得见。这道门禁保证它们不再散开。
 */

import { STRATA, strataDeclarations, stratum } from "../apps/desktop/src/shell/strata";

const css = await Bun.file("apps/desktop/src/styles/surfaces.css").text();

const failures: string[] = [];

// 一、样式表里的层变量必须与 strata.ts 逐字一致。
for (const line of strataDeclarations().split("\n")) {
  if (!css.includes(line.trim())) {
    failures.push(`surfaces.css 缺少或不符：${line.trim()}`);
  }
}

// 二、除了两处已注明的元素内部堆叠，不准再出现裸的 z-index 数字。
const INTERNAL_STACKING = 2;
const bare = [...css.matchAll(/z-index:\s*\d+;/g)];
if (bare.length > INTERNAL_STACKING) {
  failures.push(
    `surfaces.css 有 ${bare.length} 处裸 z-index，只允许 ${INTERNAL_STACKING} 处元素内部堆叠；` +
      `跨层的先后必须用 var(--z-*)：${bare.map((m) => m[0]).join(" ")}`,
  );
}

// 三、光必须在正文之上、四区之下。这是「面板挡住光」得以成立的唯一原因，
// 也是两盏灯能被眼睛区分的前提。
if (!(stratum("manuscript") < stratum("lamp") && stratum("lamp") < stratum("quarter"))) {
  failures.push("光源区必须在正文区之上、四区之下");
}

// 四、书脊在四区之上。它曾经反过来。
if (stratum("spine") <= stratum("quarter")) {
  failures.push("多层书脊必须在四区之上");
}

// 五、光源区必须真的是 DOM 里的一层，而不是画在别的东西上。
const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
if (!workbench.includes('class="lamp-layer"')) {
  failures.push("Workbench 里没有光源区这一层；光又被画回到别的元素上了");
}
const lampLayer = css.slice(css.indexOf(".lamp-layer {"));
if (!lampLayer.slice(0, 400).includes("z-index: var(--z-lamp)")) {
  failures.push(".lamp-layer 没有站在光源区那一层");
}

// 六、纸上的光必须由灯的位置推出，不再各调各的。
if (!css.includes("--lamp-facing")) {
  failures.push("纸上的光没有引用灯的朝向；两盏灯又会变回同一圈影子");
}

if (failures.length > 0) {
  console.error(failures.map((f) => `  ✗ ${f}`).join("\n"));
  process.exit(1);
}
console.log(`strata ok — ${STRATA.length} 层，样式表零裸数字`);
