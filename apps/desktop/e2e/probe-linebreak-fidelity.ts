/**
 * 接管折行之前必须先回答的问题：引擎的 em 宽度模型与浏览器的真实排版差多少。
 *
 * 引擎 `widthEm` 把每个西文字符按 0.5em 计（`spacing.ts:185`）。Handoff 十二节
 * 已经量到真实字宽 `i`=0.313em、`W`=1.063em——差三倍多。CJK 那一侧是准的
 * （全角字身恒为 1em），所以偏差集中在西文与混排。
 *
 * 这个偏差在「只算断点、由浏览器画」的模式下不致命：断点算错了浏览器还会自己
 * 折。**一旦我们接管画行，算错就是画错**——一行会溢出版心或提前收尾，而且
 * 屏幕上看得见。
 *
 * 所以这个探针问三件事：
 *
 * 1. 纯中文段落：引擎预测的行数与浏览器实际折出的行数差多少？（应为 0）
 * 2. 中英混排：差多少？
 * 3. 若把西文改用真实 `measureText` 宽度，差距是否消失？
 *
 * 第 3 问决定接管的形状：若真实度量能消除差距，接管就是「引擎算断点 + 度量
 * 由浏览器提供」；若不能，说明还有别的偏差源，接管前必须先找出来。
 *
 * 跑法：bun apps/desktop/e2e/probe-linebreak-fidelity.ts
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
  {
    name: "标点密集",
    text: "他说：「这样也行？」「不行。」「那，怎么办呢……」——沉默；然后，又是沉默。",
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
  p {
    margin: 0;
    font: ${FONT_PX}px/1.9 "Noto Sans SC", sans-serif;
    white-space: pre-wrap;
    line-break: strict;
    word-break: normal;
  }
</style>
<p id="probe"></p>`);

interface Row {
  readonly name: string;
  readonly measureEm: number;
  readonly engineLines: number;
  readonly browserLines: number;
}

const rows: Row[] = [];
for (const item of CORPUS) {
  for (const measureEm of MEASURES_EM) {
    const measured = measure(item.text, ZH_HANS);
    const engineLines = optimizedLineStarts(measured, ZH_HANS, measureEm).length;
    const browserLines = await page.evaluate(
      ({ text, widthPx }) => {
        const paragraph = document.getElementById("probe") as HTMLElement;
        paragraph.style.width = `${widthPx}px`;
        paragraph.textContent = text;
        // 行数 = 内容高度 / 行高。比数 Range 更可靠：Range 的换行位置在
        // 不同引擎上有细微差别，而高度是浏览器自己认的行数。
        const style = getComputedStyle(paragraph);
        const lineHeight = Number.parseFloat(style.lineHeight);
        return Math.round(paragraph.getBoundingClientRect().height / lineHeight);
      },
      { text: item.text, widthPx: measureEm * FONT_PX },
    );
    rows.push({ name: item.name, measureEm, engineLines, browserLines });
  }
}

await browser.close();

console.log("语料\t版心em\t引擎行数\t浏览器行数\t差");
let worst = 0;
for (const row of rows) {
  const delta = row.engineLines - row.browserLines;
  worst = Math.max(worst, Math.abs(delta));
  console.log(
    `${row.name}\t${row.measureEm}\t${row.engineLines}\t${row.browserLines}\t${delta > 0 ? "+" : ""}${delta}`,
  );
}
console.log(`\n最大行数差：${worst}`);
console.log(
  worst === 0
    ? "引擎与浏览器同解——em 模型足以接管"
    : "引擎与浏览器不同解：接管之前必须先解决宽度模型，否则接管等于把这个差画出来",
);
