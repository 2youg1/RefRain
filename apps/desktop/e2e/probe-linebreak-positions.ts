/**
 * 接管折行之前的第二问：断点**位置**是否一致（行数一致不代表断在同一处）。
 *
 * 第一版探针只比行数，12 组里 11 组同解——那个结论太乐观。行数是粗指标：
 * 两个算法可以断在完全不同的位置而恰好得到相同行数，而接管之后作者看到的是
 * 位置，不是行数。
 *
 * 这个探针逐行比对断点的字符下标，并对每一行量出**实际渲染宽度**与版心的关系：
 * 溢出版心是硬错误（接管后会真的画出去），远小于版心是软错误（行提前收尾，
 * 版面变松）。
 *
 * 跑法：bun apps/desktop/e2e/probe-linebreak-positions.ts
 */

import { chromium } from "playwright";
import { measure, optimizedLineStarts, ZH_HANS } from "../../../packages/typeset/src/index.ts";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

const CORPUS: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
  {
    name: "纯中文",
    text: "排版这件事的难处不在于把字摆整齐，而在于每一次摆放都要同时满足几条互相拉扯的规矩，而它们的优先级从来没有被写在同一张纸上。",
  },
  {
    name: "中英混排",
    text: "这个模块用 TypeScript 写成，导出 measure 与 optimizedLineStarts 两个纯函数，前者返回 AdjustedChar 数组，后者返回行首下标。",
  },
  {
    name: "西文为主",
    text: "The width model assumes every western character occupies half an em, which is wrong for both i and W, and the error accumulates across a line.",
  },
];

const MEASURES_EM = [20, 30, 40];
const FONT_PX = 17;

await ensureNodeDriver(import.meta.url);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  p { margin: 0; font: ${FONT_PX}px/1.9 "Noto Sans SC", sans-serif;
      white-space: pre-wrap; line-break: strict; word-break: normal; }
</style>
<p id="probe"></p>`);
await page.evaluate(() => document.fonts.ready);

/** 浏览器认定的行首字符下标：逐字符量 Range 的 top，top 变了就是新行。 */
const browserStarts = async (text: string, widthPx: number): Promise<number[]> =>
  page.evaluate(
    ({ text, widthPx }) => {
      const paragraph = document.getElementById("probe") as HTMLElement;
      paragraph.style.width = `${widthPx}px`;
      paragraph.textContent = text;
      const node = paragraph.firstChild as Text;
      const starts: number[] = [0];
      let previousTop: number | null = null;
      for (let index = 0; index < text.length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const top = range.getBoundingClientRect().top;
        if (previousTop !== null && top > previousTop + 1) starts.push(index);
        previousTop = top;
      }
      return starts;
    },
    { text, widthPx },
  );

/**
 * 引擎给的行，逐行在浏览器里量真实像素宽度。
 *
 * 第一版把 `width` 留在版心值上量，于是每一行都报出 100.0%——量到的是**容器
 * 宽度**而不是文字宽度，判据恒真。`width: max-content` 才让盒子收缩到内容，
 * 这时数字才是「这一行的文字有多宽」。
 */
const lineWidths = async (
  text: string,
  starts: readonly number[],
  widthPx: number,
): Promise<number[]> =>
  page.evaluate(
    ({ text, starts }) => {
      const paragraph = document.getElementById("probe") as HTMLElement;
      // nowrap + max-content：量「这一行不折行有多宽」，与版心比才有意义。
      paragraph.style.whiteSpace = "nowrap";
      paragraph.style.width = "max-content";
      const widths: number[] = [];
      for (let index = 0; index < starts.length; index += 1) {
        const from = starts[index] as number;
        const to = index + 1 < starts.length ? (starts[index + 1] as number) : text.length;
        paragraph.textContent = text.slice(from, to);
        widths.push(paragraph.getBoundingClientRect().width);
      }
      paragraph.style.whiteSpace = "pre-wrap";
      return widths;
    },
    { text, starts: [...starts] },
  );

console.log("语料\t版心\t引擎断点\t浏览器断点\t位置一致\t最宽行/版心");
let anyOverflow = false;
let mismatches = 0;
for (const item of CORPUS) {
  for (const measureEm of MEASURES_EM) {
    const widthPx = measureEm * FONT_PX;
    const engine = optimizedLineStarts(measure(item.text, ZH_HANS), ZH_HANS, measureEm);
    const browser = await browserStarts(item.text, widthPx);
    const same = JSON.stringify([...engine]) === JSON.stringify(browser);
    if (!same) mismatches += 1;
    const widths = await lineWidths(item.text, engine, widthPx);
    const worst = Math.max(...widths);
    const ratio = worst / widthPx;
    if (ratio > 1.001) anyOverflow = true;
    console.log(
      `${item.name}\t${measureEm}em\t${engine.length}行 ${JSON.stringify([...engine])}\t${browser.length}行 ${JSON.stringify(browser)}\t${same ? "是" : "否"}\t${(ratio * 100).toFixed(1)}%`,
    );
  }
}

await browser.close();
console.log(`\n断点位置不一致：${mismatches} / ${CORPUS.length * MEASURES_EM.length} 组`);
console.log(
  anyOverflow
    ? "**有行溢出版心**：接管后这些行会真的画到版心外面"
    : "没有行溢出版心：引擎的断点在真实度量下都放得下",
);
