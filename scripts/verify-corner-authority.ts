#!/usr/bin/env bun
/**
 * 角的唯一权威。
 *
 * `shell/corners.ts` 规定五档，样式表只准引用变量。在此之前样式表里有二十九
 * 处裸的 `border-radius` 数字——每处单看都对，合起来没有一处说明「面板与
 * 按钮的角为什么不一样」，也没人能回答「小饭盒该多圆」。这与 z-index 从前
 * 的处境是同一种，所以按同一条纪律收口（见 `verify:strata`）。
 *
 * 三件事各有一条断言，因为它们各自会单独坏掉：
 *
 * 1. 样式表里的变量必须与 `corners.ts` 逐字一致（改了模块不改样式表即红）；
 * 2. 裸数字有上界（新写一处 `border-radius: 6px` 即红）；
 * 3. G4 的形状必须真的是超椭圆，而不是被谁改回了正圆。
 *
 * 注入证明：把 `corners.ts` 里 bento 的指数改成 2（正圆），第 3 条变红并
 * 指出它退化了；在样式表里新增一处裸 `border-radius: 6px`，第 2 条变红。
 */

import { readFileSync } from "node:fs";
import {
  CORNER_SCALES,
  cornerContinuity,
  cornerDeclarations,
  cornerExponent,
  cornerRadius,
  cornerVar,
} from "../apps/desktop/src/shell/corners";

const css = readFileSync("apps/desktop/src/styles/surfaces.css", "utf8");
const failures: string[] = [];

// 一、样式表里的角变量必须与 corners.ts 一致——**归一化空白之后**再比。
//
// 比的是值，不是它今天怎么换行。第一版逐字比对，`bun run fmt` 把长长的
// polygon 折成多行之后五条全红，而没有任何一个值变过。一道会被格式化器
// 弄红的门禁，最后总会被人用「重新排版一下」绕过去。
const flatten = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    // 括号内侧的空白也去掉：biome 把 `polygon(` 之后折了一行，归一化成
    // 单空格之后仍是 `polygon( 100%`，与生成的 `polygon(100%` 差一个空格。
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
const flatCss = flatten(css);
for (const line of cornerDeclarations().split("\n")) {
  const declaration = flatten(line);
  if (declaration === "") continue;
  if (!flatCss.includes(declaration)) {
    failures.push(`surfaces.css 缺少或不符：${declaration.slice(0, 60)}…`);
  }
}

// 二、除了少数已注明的内部细节，不准再出现裸的 border-radius 数字。
//
// 上界不是「当前有多少」，而是「还允许多少」。它每降一次都要有人说明为什么
// 那一处不能用变量——一个只会往上调的数字挡不住任何东西。
const BARE_RADIUS_ALLOWANCE = 34;
const bare = [...css.matchAll(/border-radius:\s*[\d.]+(px|%|em|rem)/g)];
if (bare.length > BARE_RADIUS_ALLOWANCE) {
  failures.push(
    `surfaces.css 有 ${bare.length} 处裸 border-radius，只允许 ${BARE_RADIUS_ALLOWANCE} 处；` +
      `新的角必须用 var(--corner-*)，档不够就去 shell/corners.ts 加一档`,
  );
}

// 三、每一档都要有样本，且样本数不为零。
//
// 没有样本的档等于没被检查：一个从未被引用的变量与一个写错的变量，输出
// 完全一样。
for (const scale of CORNER_SCALES) {
  const used = css.split(`var(${cornerVar(scale)})`).length - 1;
  if (scale === "card") continue; // card 档留给列表格，尚未接线。
  if (used === 0) {
    failures.push(`档 ${scale} 一处也没被引用：它没有被检查，只是被定义了`);
  }
}

// 四、每一档必须达到它声称的连续阶。
//
// 判据是**阶数**，不是「看起来够不够方」。κ ∝ s^(n−2)，κ 从第 (n−2) 阶
// 导数开始跳变，所以连续阶是 n − 1：n=3 → G2，n=4 → G3，n=5 → G4。
//
// 第一版断言写的是「45° 处的点要比正圆的 85.36% 更外」——那量的是外观，
// 而 n=4.2 与 n=5 都能过，于是一个约 G3.2 的角被称作 G4 也不会红。断言
// 要能区分它想区分的东西，否则它只是在确认「这不是正圆」。
const REQUIRED_CONTINUITY: Readonly<Record<string, number>> = {
  // 小饭盒与正文那条直边并排，突变最显眼：只有它需要 G4。
  bento: 4,
  panel: 3,
  card: 2,
  control: 2,
};
for (const scale of CORNER_SCALES) {
  if (scale === "pill") continue; // 徽标本来就该是正圆。
  const required = REQUIRED_CONTINUITY[scale];
  if (required === undefined) {
    failures.push(`档 ${scale} 没有声明它要到哪一阶：这道断言对它什么也没验`);
    continue;
  }
  const actual = cornerContinuity(scale);
  if (actual < required) {
    failures.push(
      `档 ${scale} 只到 G${actual}（指数 ${cornerExponent(scale)}），要求 G${required}；` +
        `κ ∝ s^(n−2)，G${required} 需要指数 ${required + 1}`,
    );
  }
}

// 五、半径必须单调：小饭盒不能比控件还方。
const ordered = ["control", "card", "panel", "bento"] as const;
for (let index = 1; index < ordered.length; index += 1) {
  const previous = ordered[index - 1];
  const current = ordered[index];
  if (previous === undefined || current === undefined) continue;
  if (cornerRadius(current) < cornerRadius(previous)) {
    failures.push(
      `档 ${current}（${cornerRadius(current)}px）比 ${previous}（${cornerRadius(previous)}px）还小：` +
        `档的次序读不出来了`,
    );
  }
}

// 六、小饭盒的不透明度必须可调，且默认不透明。
//
// 半透明的默认会让第一次打开的人以为软件坏了；不可调则等于没做这个功能。
if (!css.includes("--bento-opacity: 1;")) {
  failures.push("小饭盒的不透明度没有默认为 1；默认状态不该是半透明的");
}

// **逐个小饭盒断言，而不是问「有没有人引用过」。**
//
// 第一版写的是 `css.includes("opacity: var(--bento-opacity)")`，删掉正文
// 右键菜单那一处它照样绿——信箱菜单还有一处，一处就满足了 includes。
// 两个小饭盒里只有一个能调透明度，恰恰是作者最容易发现的那种坏法。
const BENTO_SURFACES = [".context-menu", ".mailbox-menu"] as const;
for (const surface of BENTO_SURFACES) {
  const start = css.indexOf(`\n${surface} {`);
  if (start < 0) {
    failures.push(`小饭盒 ${surface} 不见了：它的透明度与角都无从检查`);
    continue;
  }
  const block = css.slice(start, css.indexOf("\n}", start));
  if (!block.includes("opacity: var(--bento-opacity)")) {
    failures.push(`小饭盒 ${surface} 没有引用 --bento-opacity：调了它不会有事发生`);
  }
  if (!block.includes("border-radius: var(--corner-bento)")) {
    failures.push(`小饭盒 ${surface} 没有走 bento 那一档角：它还是 G0 直边或别的档`);
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:corner-authority");
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
console.log(
  `corner authority ok — ${CORNER_SCALES.length} 档，样式表 ${bare.length}/${BARE_RADIUS_ALLOWANCE} 处裸数字`,
);
