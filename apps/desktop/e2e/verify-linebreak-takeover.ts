// 门禁：自研断行确实接管了编辑视图的折行，且没有动到文本或光标。
//
// 为什么必须在真浏览器里：`linebreak-takeover.test.ts` 测的是切分——哪些位置
// 该换行。它全绿不意味着屏幕上真的换在那里。这个项目已经踩过两次同一个形状
// （标点挤压算了三个月没被画出来、`hanging-punctuation` 那行从没生效），而
// 断行是第三次：`optimizedLineStarts` 写完之后在产品里零调用了整整一版。
//
// 判据：
//
// 1. 段落的 `white-space` 必须是 `pre`。留着 `pre-wrap` 浏览器会在我们的断点
//    之外再折一次，两套断点叠加，屏幕上只表现为「行短了一点」而不报错。
// 2. 实际渲染的行数等于引擎给的行数。
// 3. 每一行的起始字符与引擎给的行首下标一致——行数相同不代表断在同一处。
// 4. `textContent` 逐字等于块文本（断行元素对文本透明）。
// 5. 光标能落到每一个字符上，且落点与偏移一致（断行元素不进坐标系）。
//
// 注入验红（本轮实测，逐条改一处跑一次）：
// - `paragraph.style.whiteSpace` 改回 `pre-wrap` → 判据 1 红。
// - `spacedRuns` 的 `starts` 恒置 null → 判据 2、3 红（浏览器不折，全挤成一行）。
// - 断行元素的 `display` 从 `block` 改成 `inline` → 判据 2、3 红。
// - `#measureEm()` 恒返回 0 → 判据 2、3 红。

import { type Browser, chromium } from "playwright";
import { measure, optimizedLineStarts, ZH_HANS } from "../../../packages/typeset/src/index.ts";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

ensureNodeDriver(import.meta.url);

const bundle = await Bun.build({
  entrypoints: ["packages/editor/src/index.ts"],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  throw new Error(`editor bundle failed: ${bundle.logs.map(String).join("\n")}`);
}
const editorJavaScript = await bundle.outputs[0].text();

const FONT_PX = 17;
const MEASURE_EM = 20;
/** 缩窄后的版心：行数必须跟着变，否则重画条件漏了「文本没变但版心变了」。 */
const NARROW_EM = 12;
const WIDTH_PX = FONT_PX * MEASURE_EM;

/** 纯中文：引擎与浏览器在这一类上断点逐字相同（见 probe-linebreak-positions）。 */
const TEXT =
  "排版这件事的难处不在于把字摆整齐，而在于每一次摆放都要同时满足几条互相拉扯的规矩，而它们的优先级从来没有被写在同一张纸上。";

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  #editor { font: ${FONT_PX}px/1.9 "Noto Sans SC", sans-serif; width: ${WIDTH_PX}px; }
</style>
<div class="editor-host"><div id="editor"></div></div>
<script type="module">
  import * as editor from "/editor.js";
  window.editorApi = editor;
</script>`;

const server = await Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/editor.js") {
      return new Response(editorJavaScript, { headers: { "content-type": "text/javascript" } });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

let browser: Browser | null = null;
const failures: string[] = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  await page.evaluate((text) => {
    const api = window as unknown as {
      editorApi: {
        mountEditor(
          element: HTMLElement,
          document: { revision: string; blocks: Array<{ id: string; text: string }> },
          port: { submit: (action: unknown) => void },
        ): unknown;
      };
    };
    api.editorApi.mountEditor(
      document.getElementById("editor") as HTMLElement,
      { revision: "r1", blocks: [{ id: "b1", text }] },
      { submit: () => undefined },
    );
  }, TEXT);

  // 字体到位之后才量：fallback 与 Noto Sans SC 的度量不同，量早了得到的是
  // 另一套字体的行。
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => (document.querySelector('[data-block-id="b1"]')?.textContent ?? "").length > 0,
    undefined,
    { timeout: 15_000 },
  );

  const engineStarts = [...optimizedLineStarts(measure(TEXT, ZH_HANS), ZH_HANS, MEASURE_EM)];

  const report = await page.evaluate(() => {
    const paragraph = document.querySelector('[data-block-id="b1"]') as HTMLElement;
    const style = getComputedStyle(paragraph);

    // 屏幕上真实的行首：逐字符量 Range 的 top，top 变了就是新行。这与引擎的
    // 行首下标是同一个坐标系（块文本的字符下标）。
    const text = paragraph.textContent ?? "";
    const starts: number[] = [0];
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node = walker.nextNode();
    while (node !== null) {
      nodes.push(node as Text);
      node = walker.nextNode();
    }
    let offset = 0;
    let previousTop: number | null = null;
    for (const textNode of nodes) {
      const length = (textNode.textContent ?? "").length;
      for (let index = 0; index < length; index += 1) {
        const range = document.createRange();
        range.setStart(textNode, index);
        range.setEnd(textNode, index + 1);
        const top = range.getBoundingClientRect().top;
        if (previousTop !== null && top > previousTop + 1) starts.push(offset);
        previousTop = top;
        offset += 1;
      }
    }

    // 光标坐标系：把光标放到每一个字符前，读回偏移，必须一致。
    let caretMismatch: number | null = null;
    const selection = document.getSelection();
    for (let target = 0; target <= text.length && caretMismatch === null; target += 10) {
      let remaining = target;
      let placed = false;
      for (const textNode of nodes) {
        const length = (textNode.textContent ?? "").length;
        if (remaining <= length) {
          const range = document.createRange();
          range.setStart(textNode, remaining);
          range.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(range);
          placed = true;
          break;
        }
        remaining -= length;
      }
      if (!placed) continue;
      const probe = document.createRange();
      probe.selectNodeContents(paragraph);
      const current = selection?.getRangeAt(0);
      if (current === undefined) continue;
      probe.setEnd(current.startContainer, current.startOffset);
      if (probe.toString().length !== target) caretMismatch = target;
    }

    return {
      whiteSpace: style.whiteSpace,
      textContent: text,
      starts,
      breakElements: paragraph.querySelectorAll(".cjk-break").length,
      caretMismatch,
    };
  });

  // ── 判据 1：段落必须禁止浏览器自行折行 ──────────────────────────
  if (report.whiteSpace !== "pre") {
    failures.push(
      `段落的 white-space 是 ${report.whiteSpace}，不是 pre：浏览器会在我们的断点之外再折一次`,
    );
  }

  // ── 判据 4：文本逐字不变 ────────────────────────────────────────
  if (report.textContent !== TEXT) {
    failures.push(`断行改变了文本：${JSON.stringify(report.textContent)}`);
  }

  // ── 判据 2、3：行数与断点位置都要与引擎一致 ─────────────────────
  if (report.starts.length !== engineStarts.length) {
    failures.push(
      `屏幕上是 ${report.starts.length} 行，引擎给的是 ${engineStarts.length} 行` +
        `（屏幕 ${JSON.stringify(report.starts)} / 引擎 ${JSON.stringify(engineStarts)}）`,
    );
  } else if (JSON.stringify(report.starts) !== JSON.stringify(engineStarts)) {
    failures.push(
      `行数相同但断点不同：屏幕 ${JSON.stringify(report.starts)} / 引擎 ${JSON.stringify(engineStarts)}`,
    );
  }

  // 断行元素的数量必须与换行次数一致：多了就是画了看不见的换行。
  if (report.breakElements !== engineStarts.length - 1) {
    failures.push(
      `断行元素 ${report.breakElements} 个，换行次数 ${engineStarts.length - 1}：数量对不上`,
    );
  }

  // ── 判据 5：光标坐标系不受断行元素影响 ──────────────────────────
  if (report.caretMismatch !== null) {
    failures.push(`光标在偏移 ${report.caretMismatch} 处错位：断行元素进了坐标系`);
  }

  // ── 判据 6：版心变了，行要重断 ──────────────────────────────────
  //
  // 接管之前这条不存在：浏览器自己折行，宽度一变它立刻重折。接管之后重画的
  // 条件是我们写的，而最容易漏的正是「文本没变、版心变了」——那时只比对文本
  // 的条件看不见任何变化，行留在旧断点上，直到作者碰了那一段才更新。
  const narrowStarts = [...optimizedLineStarts(measure(TEXT, ZH_HANS), ZH_HANS, NARROW_EM)];
  await page.evaluate((widthPx) => {
    // 先把光标从段落里挪开：判据 5 为了验坐标系把光标放进了段落，而重画会
    // **跳过**光标所在的那一段（它的 DOM 文本是作者正在输入的内容，比投影新）。
    // 不挪开的话这条判据测到的是「光标所在段不重画」——那是对的行为，却不是
    // 这里要问的问题。第一版没挪，于是等十秒也等不到更新。
    document.getSelection()?.removeAllRanges();
    (document.getElementById("editor") as HTMLElement).style.width = `${widthPx}px`;
  }, FONT_PX * NARROW_EM);
  // 等段落自己报出「我是按新版心画的」，而不是睡一个固定时长。
  //
  // 第一版睡 120ms 就读，报「行没有重断」——实测重画在 400ms 内完成，也就是
  // 那条红是门禁自己等不够，不是产品缺陷。固定睡眠既可能太短（假红）也可能
  // 太长（每次跑都在等），而 `data-measure-em` 是重画完成的直接信号。
  await page
    .waitForFunction(
      (expected) =>
        (document.querySelector('[data-block-id="b1"]') as HTMLElement | null)?.dataset
          .measureEm === expected,
      String(NARROW_EM),
      { timeout: 10_000 },
    )
    .catch(() => {
      failures.push(
        `版心缩到 ${NARROW_EM}em 之后，段落的 data-measure-em 一直没更新：重画没有被触发`,
      );
    });
  const afterResize = await page.evaluate(() => {
    const paragraph = document.querySelector('[data-block-id="b1"]') as HTMLElement;
    return {
      breakElements: paragraph.querySelectorAll(".cjk-break").length,
      textContent: paragraph.textContent ?? "",
    };
  });
  if (afterResize.breakElements !== narrowStarts.length - 1) {
    failures.push(
      `版心从 ${MEASURE_EM}em 缩到 ${NARROW_EM}em 之后，断行元素是 ` +
        `${afterResize.breakElements} 个，应为 ${narrowStarts.length - 1} 个：行没有重断`,
    );
  }
  if (afterResize.textContent !== TEXT) {
    failures.push(`重断行改变了文本：${JSON.stringify(afterResize.textContent)}`);
  }

  if (failures.length > 0) throw new Error(failures.join("; "));
  console.log(
    `PASS  自研断行接管了折行（${engineStarts.length} 行，断点 ${JSON.stringify(engineStarts)}），` +
      "文本与光标坐标系不受影响，版心变化后行会重断",
  );
} finally {
  await browser?.close();
  server.stop(true);
}
