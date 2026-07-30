/**
 * 滚动一格，浏览器要搬动多少个节点。
 *
 * 现在的渲染每帧走 `replaceChildren(fragment)`：段落元素本身是复用的（有一张
 * previous map），但整窗 200 个节点仍会被从 DOM 摘下再插回，浏览器要重算整棵
 * 子树。滚动一格实际只有几个块进出窗口。
 *
 * 这个探针对比两种做法在同一份稿子上的耗时：整窗替换，与只增删差集。不改产品
 * 代码，只在一个裸页面里复现两种写法——先看差距值不值得改，再动手。
 *
 * 跑法：
 *   bun apps/desktop/e2e/probe-window-diff.ts
 */

import { chromium } from "playwright";

const TOTAL = 100_000;
const WINDOW = 200;
/** 滚动多少次；每次前进一屏三分之一左右，模拟连续阅读。 */
const STEPS = 120;
const STRIDE = 12;

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  #host { height: 900px; overflow: auto; }
  p { margin: 0 0 12px; line-height: 1.6; font-size: 16px; }
</style>
<div id="host"><div id="doc"></div></div>
`;

const script = (total: number, window: number, steps: number, stride: number): string => `
(() => {
  const doc = document.getElementById("doc");
  const texts = [];
  for (let i = 0; i < ${total}; i += 1) {
    texts.push("第 " + i + " 段的正文，长度适中，用来撑出一章的规模。");
  }

  const make = (index) => {
    const p = document.createElement("p");
    p.dataset.blockId = "b" + index;
    p.textContent = texts[index];
    return p;
  };

  // 甲：整窗替换（现在的做法）。段落复用，但每帧都 replaceChildren。
  const wholeWindow = () => {
    let held = new Map();
    return (start) => {
      const previous = held;
      held = new Map();
      const fragment = document.createDocumentFragment();
      for (let i = start; i < start + ${window}; i += 1) {
        const node = previous.get(i) ?? make(i);
        held.set(i, node);
        fragment.append(node);
      }
      doc.replaceChildren(fragment);
    };
  };

  // 乙：只动差集。窗口滑动时，把离开的摘掉、进来的插到正确位置。
  const diffOnly = () => {
    let held = new Map();
    let low = -1;
    return (start) => {
      const end = start + ${window};
      if (low < 0) {
        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i += 1) {
          const node = make(i);
          held.set(i, node);
          fragment.append(node);
        }
        doc.replaceChildren(fragment);
        low = start;
        return;
      }
      for (const [index, node] of held) {
        if (index < start || index >= end) {
          node.remove();
          held.delete(index);
        }
      }
      for (let i = start; i < end; i += 1) {
        if (held.has(i)) continue;
        const node = make(i);
        held.set(i, node);
        // 插到它该在的位置：找到下一个已存在的兄弟。
        let anchor = null;
        for (let j = i + 1; j < end; j += 1) {
          const candidate = held.get(j);
          if (candidate !== undefined && candidate.parentNode === doc) {
            anchor = candidate;
            break;
          }
        }
        doc.insertBefore(node, anchor);
      }
      low = start;
    };
  };

  const measure = (render) => {
    render(0);
    // 强制一次同步布局，把首帧成本排除在计时之外。
    void doc.getBoundingClientRect();
    const samples = [];
    for (let step = 1; step <= ${steps}; step += 1) {
      const start = step * ${stride};
      const t0 = performance.now();
      render(start);
      // 读一次几何量，逼浏览器把这一帧的布局真的算完——否则测到的只是排队时间。
      void doc.getBoundingClientRect();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return {
      p50: samples[Math.floor(samples.length * 0.5)],
      p95: samples[Math.floor(samples.length * 0.95)],
      max: samples[samples.length - 1],
      total: samples.reduce((sum, one) => sum + one, 0),
    };
  };

  const whole = measure(wholeWindow());
  doc.replaceChildren();
  const diff = measure(diffOnly());
  return { whole, diff };
})()
`;

const main = async (): Promise<void> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(HTML);
    const result = await page.evaluate(script(TOTAL, WINDOW, STEPS, STRIDE));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
};

await main();
