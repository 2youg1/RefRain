/**
 * 实测：CSS Custom Highlight 在**零宽 Range** 上到底画不画得出来。
 *
 * 起因是删除标记。`diffSpans` 对纯删除返回 `{start: n, end: n}`——一个零宽
 * 区间，因为被删掉的文本在新版里根本不存在，没有字符可以着色。问题是这样
 * 一个 Range 交给 Highlight API 之后，屏幕上会不会有任何东西。
 *
 * 不实测就写下的答案会是「零宽画不出底色，改用下划线」——而下划线同样需要
 * 一段宽度才画得出来。两个都是推理，都可能错。
 *
 * 跑法：bun apps/desktop/e2e/probe-zero-width-highlight.ts
 */

import { chromium } from "playwright";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

await ensureNodeDriver();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.setContent(`<!doctype html>
<style>
  body { margin: 0; font: 16px/1.6 sans-serif; }
  p { margin: 0; padding: 0; width: 400px; }
  ::highlight(probe-zero) { background: rgb(255, 0, 0); text-decoration: underline 2px rgb(255,0,0); }
  ::highlight(probe-wide) { background: rgb(0, 0, 255); }
</style>
<p id="zero">前面的文字这里删过后面的文字</p>
<p id="wide">前面的文字这里删过后面的文字</p>`);

const result = await page.evaluate(() => {
  const measure = (id: string, name: string, start: number, end: number) => {
    const element = document.getElementById(id) as HTMLElement;
    const text = element.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    // @ts-expect-error Highlight 尚未进 TS lib
    CSS.highlights.set(name, new Highlight(range));
    const rect = range.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };
  return {
    zero: measure("zero", "probe-zero", 6, 6),
    wide: measure("wide", "probe-wide", 6, 9),
  };
});

// 截图供人眼确认：数字说 Range 的几何，像素说画没画出来。
await page.screenshot({ path: "/tmp/zero-width-highlight.png" });
await browser.close();

console.log(JSON.stringify(result, null, 2));
console.log(
  result.zero.width === 0
    ? "零宽 Range 的宽度确实是 0——Highlight 在它上面画不出任何可见像素"
    : `零宽 Range 报出了 ${result.zero.width}px 宽度，推理错了`,
);
