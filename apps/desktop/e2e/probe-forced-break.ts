/**
 * 接管折行的机制选型：怎样在**不改变 `textContent`** 的前提下强制浏览器在
 * 我们指定的位置换行。
 *
 * 约束来自这个编辑器的既有性质，不能放弃：
 *
 * - `textContent` 必须逐字等于块文本。光标偏移、选区、复制、`#highlightFence`
 *   的守卫、diff 着色的 `locateOffset` 全都建立在这个坐标系上。
 * - 磁盘字节不变（INV：着色与排版都是渲染派生物）。
 * - 间距元素（`cjk-gap`）已经证明空元素对 `textContent` 是透明的。
 *
 * 三个候选：
 *
 * A. 插入 `<br>`：最直接，但 `<br>` 在 `textContent` 里**是一个 \n**（实测本
 *    探针第一问），会破坏坐标系。
 * B. 插入零宽元素 + `display: block` 之类的强制断行：元素不含文本节点，
 *    `textContent` 不受影响（间距元素已证）。问题是它能否真的断行。
 * C. 每行包一个 block 级 span：结构改动最大，且会影响选区跨行。
 *
 * 这个探针实测三者对 `textContent`、光标偏移与实际换行的影响。
 *
 * 跑法：bun apps/desktop/e2e/probe-forced-break.ts
 */

import { chromium } from "playwright";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

await ensureNodeDriver(import.meta.url);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  p { margin: 0; font: 17px/1.9 "Noto Sans SC", sans-serif;
      white-space: pre-wrap; width: 600px; }
  .brk-block { display: block; height: 0; }
  .brk-flex { display: inline-block; width: 100%; height: 0; }
</style>
<p id="a"></p><p id="b"></p><p id="c"></p>`);

const TEXT = "第一部分的文字第二部分的文字";
const SPLIT = 7;

const report = await page.evaluate(
  ({ text, split }) => {
    const build = (id: string, make: () => Node | null) => {
      const paragraph = document.getElementById(id) as HTMLElement;
      paragraph.textContent = "";
      paragraph.appendChild(document.createTextNode(text.slice(0, split)));
      const breaker = make();
      if (breaker !== null) paragraph.appendChild(breaker);
      paragraph.appendChild(document.createTextNode(text.slice(split)));
      // 行数：内容高度 / 行高。
      const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
      const lines = Math.round(paragraph.getBoundingClientRect().height / lineHeight);
      // 光标坐标系：`caretWithin` 用 Range.toString().length 数偏移，
      // `placeCaret`/`locateOffset` 用 TreeWalker 累加文本节点长度。两者必须
      // 与块文本的下标一致，否则断行元素会把光标推到错的字符上。
      // 断行元素之后的第一个字符，其偏移应当正好是 split。
      const probe = document.createRange();
      probe.selectNodeContents(paragraph);
      const after = paragraph.lastChild as Text;
      probe.setEnd(after, 0);
      const caretOk = probe.toString().length === split;
      return { textContent: paragraph.textContent ?? "", lines, caretOk };
    };

    const br = build("a", () => document.createElement("br"));
    const blockSpan = build("b", () => {
      const span = document.createElement("span");
      span.className = "brk-block";
      span.contentEditable = "false";
      return span;
    });
    const flexSpan = build("c", () => {
      const span = document.createElement("span");
      span.className = "brk-flex";
      span.contentEditable = "false";
      return span;
    });
    return { br, blockSpan, flexSpan, expected: text };
  },
  { text: TEXT, split: SPLIT },
);

await browser.close();

const verdict = (
  name: string,
  result: { textContent: string; lines: number; caretOk: boolean },
) => {
  const clean = result.textContent === report.expected;
  console.log(
    `${name}\ttextContent ${clean ? "逐字不变" : `被改成 ${JSON.stringify(result.textContent)}`}` +
      `\t行数 ${result.lines}\t光标坐标系 ${result.caretOk ? "一致" : "**错位**"}`,
  );
  return clean && result.lines === 2 && result.caretOk;
};

console.log(
  `原文 ${JSON.stringify(report.expected)}（长 ${report.expected.length}），在第 ${SPLIT} 位断开\n`,
);
const brOk = verdict("A <br>          ", report.br);
const blockOk = verdict("B display:block ", report.blockSpan);
const flexOk = verdict("C inline-block  ", report.flexSpan);

console.log("\n可用的机制（既断行又不改 textContent）：");
for (const [name, ok] of [
  ["<br>", brOk],
  ["display:block 空元素", blockOk],
  ["width:100% inline-block 空元素", flexOk],
] as const) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
}
