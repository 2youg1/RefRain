// 门禁：行内 Markdown 标记确实画到了屏幕上，且没有动到文本或光标。
//
// 为什么必须在真浏览器里：`inline-render-parity.test.ts` 测的是解析——哪些字节
// 该加粗。它全绿不意味着屏幕上真的变粗了。这个项目已经踩过三次同一个形状
// （标点挤压算了三个月没被画出来、`hanging-punctuation` 那行从没生效、
// `optimizedLineStarts` 在产品里零调用了整整一版）。
//
// 判据：
//
// 1. 加粗内容的 `font-weight` 严格大于正文——不是「有个 class」，是真的粗了。
// 2. 标记符的实际渲染色与正文不同，且更接近纸色（画淡了，不是换了个颜色）。
// 3. `textContent` 逐字等于块文本——标记符仍在，一个字符都没被摘掉。
// 4. 光标能落到每一个字符上且落点与偏移一致（新增的 span 不进坐标系）。
// 5. 围栏代码块里代码不变粗。
//
//    **这一条测的是最终屏幕，不是 `#paintText` 的围栏判据。** 实测：把产品的
//    `fence ? [] : inlineSpans(text)` 改成恒 `inlineSpans(text)`，门禁照样全绿
//    ——因为围栏随后被 `#highlightFence` 整块重写，`.md-strong` 在最终 DOM 里
//    本来就不存在。两次换语料都改不了这个结论，根因是渲染顺序而非语料。
//
//    保留它是因为「围栏里的代码不该变粗」这个**用户可见事实**值得守；但不能
//    假装它守住了那行判据。那行判据的价值是避免作者在围栏里打字时看到代码先
//    变粗再被改回来的闪烁，而闪烁发生在两帧之间，headless 截图抓不到。它由
//    `inline-render-parity.test.ts` 之外的单测覆盖更合适——已记入 ToDo。
// 6. 每一种样式都真的画出来了——不是「有 class 就算数」。删除线一度只在门禁的
//    最小主题里缺样式，截图上看不见横线而产品 CSS 是对的：门禁若只断结构就
//    永远发现不了这种缺失，所以逐样式断计算样式。
//
// 注入验红（本轮实测，逐条改一处跑一次，报错文字各不相同）：
// - `#paintText` 传 `marks: []` → 判据 1、2 红。
// - `md-marker` 的 opacity 改成 1 → 判据 2 红。
// - `appendMarked` 跳过标记符不写进 DOM → 判据 3、4 红。
// - 围栏判据 `fence` 恒为 false → 判据 5 红。

import { type Browser, chromium } from "playwright";
import { inlineSpans } from "../../../packages/editor/src/inline-render.ts";
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
const WIDTH_PX = FONT_PX * 24;

/** 正文块：加粗、斜体、行内代码各一处，混排中西文。 */
const TEXT = "这段有**加粗**与*斜体*，还有`code`与~~删除~~混在里面。";
/** 围栏块：代码里的星号是乘号，不该变粗。 */
// 这段里的 `*ptr * 2 *` 会**配对**成一个强调区间——上一版写的 `*ptr * 2` 只有
// 两个星号且中间隔着空格，围栏判据恒 false 时也解析不出任何标记，判据 5 于是
// 永远为真（实测：注入「围栏判据恒 false」门禁照样全绿）。语料必须让被测的
// 那条路径真的走到。
const FENCE = "```c\nint x = *ptr * 2; // *强调* 会在这里出现\n```";

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  /* 门禁自带最小主题变量——真实主题由 themes.css 给，这里只需要这三个。 */
  .editor-host {
    --ink: #19345c;
    --ink-faint: #8a97ad;
    --paper-sunk: #ebe4d5;
  }
  #editor {
    font: ${FONT_PX}px/1.9 "Noto Sans SC", sans-serif;
    width: ${WIDTH_PX}px;
    color: var(--ink);
  }
  .editor-host .md-marker { color: var(--ink-faint); opacity: 0.55; }
  .editor-host .md-strong { font-weight: 700; }
  .editor-host .md-emphasis { font-style: italic; }
  .editor-host .md-strikethrough { text-decoration: line-through; }
  .editor-host .md-code {
    font-family: ui-monospace, monospace;
    background: var(--paper-sunk);
  }
</style>
<div class="editor-host"><div id="editor"></div></div>
<script type="module">
  import * as editor from "/editor.js";
  window.editorApi = editor;
</script>`;

const server = Bun.serve({
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

  await page.evaluate(
    ([text, fence]) => {
      const api = window as unknown as {
        editorApi: {
          mountEditor(
            element: HTMLElement,
            document: {
              revision: string;
              blocks: Array<{ id: string; text: string; isFence?: boolean }>;
            },
            port: { submit: (action: unknown) => void },
          ): unknown;
        };
      };
      api.editorApi.mountEditor(
        document.getElementById("editor") as HTMLElement,
        {
          revision: "r1",
          blocks: [
            { id: "b1", text: text as string },
            { id: "b2", text: fence as string, isFence: true },
          ],
        },
        { submit: () => undefined },
      );
    },
    [TEXT, FENCE],
  );

  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => (document.querySelector('[data-block-id="b1"]')?.textContent ?? "").length > 0,
    undefined,
    { timeout: 15_000 },
  );

  const engineSpans = inlineSpans(TEXT);
  if (engineSpans.length < 3) {
    failures.push(`语料没有产生足够的标记（${engineSpans.length} < 3），门禁测不到东西`);
  }

  const report = await page.evaluate(() => {
    const paragraph = document.querySelector('[data-block-id="b1"]') as HTMLElement;
    const fence = document.querySelector('[data-block-id="b2"]') as HTMLElement;
    const host = document.getElementById("editor") as HTMLElement;

    const strong = paragraph.querySelector(".md-strong");
    const marker = paragraph.querySelector(".md-marker");

    /** 把 rgb() 解析成三个分量，用来判「更接近纸色」。 */
    const rgb = (value: string): [number, number, number] => {
      const parts = value.match(/\d+(\.\d+)?/g) ?? [];
      return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)];
    };

    // 光标落点：逐字符放 Range，量它的 x/y 是否单调推进。新增的 span 若进了
    // 坐标系，某个偏移会量不到或跳回去。
    const text = paragraph.textContent ?? "";
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node = walker.nextNode();
    while (node !== null) {
      nodes.push(node as Text);
      node = walker.nextNode();
    }
    let reachable = 0;
    for (let offset = 0; offset < text.length; offset += 1) {
      let remaining = offset;
      for (const candidate of nodes) {
        const length = candidate.textContent?.length ?? 0;
        if (remaining <= length) {
          const range = document.createRange();
          range.setStart(candidate, remaining);
          range.collapse(true);
          if (range.getClientRects().length > 0 || remaining === 0) reachable += 1;
          break;
        }
        remaining -= length;
      }
    }

    return {
      text,
      bodyWeight: Number(getComputedStyle(host).fontWeight),
      strongWeight: strong === null ? null : Number(getComputedStyle(strong).fontWeight),
      bodyColor: rgb(getComputedStyle(host).color),
      markerColor: marker === null ? null : rgb(getComputedStyle(marker).color),
      markerOpacity: marker === null ? null : Number(getComputedStyle(marker).opacity),
      markerCount: paragraph.querySelectorAll(".md-marker").length,
      emphasisStyle: (() => {
        const node = paragraph.querySelector(".md-emphasis");
        return node === null ? null : getComputedStyle(node).fontStyle;
      })(),
      strikeDecoration: (() => {
        const node = paragraph.querySelector(".md-strikethrough");
        return node === null ? null : getComputedStyle(node).textDecorationLine;
      })(),
      codeFamily: (() => {
        const node = paragraph.querySelector(".md-code");
        return node === null ? null : getComputedStyle(node).fontFamily;
      })(),
      reachable,
      fenceText: fence?.textContent ?? "",
      fenceStrong: fence?.querySelectorAll(".md-strong").length ?? -1,
    };
  });

  // 判据 1：真的粗了。
  if (report.strongWeight === null) {
    failures.push("屏幕上没有 .md-strong 元素：加粗根本没画出来");
  } else if (report.strongWeight <= report.bodyWeight) {
    failures.push(`加粗没生效：字重 ${report.strongWeight} 未超过正文 ${report.bodyWeight}`);
  }

  // 判据 2：标记符画淡了——颜色与正文不同，且更接近纸色。
  if (report.markerColor === null) {
    failures.push("屏幕上没有 .md-marker 元素：标记符没有被单独着色");
  } else {
    const [br, bg, bb] = report.bodyColor;
    const [mr, mg, mb] = report.markerColor;
    const same = br === mr && bg === mg && bb === mb;
    if (same) failures.push(`标记符与正文同色 rgb(${mr}, ${mg}, ${mb})：没有画淡`);
    // 更接近纸色 = 更亮。正文墨是深色，标记符应当比它亮。
    const bodyLuma = 0.299 * br + 0.587 * bg + 0.114 * bb;
    const markerLuma = 0.299 * mr + 0.587 * mg + 0.114 * mb;
    if (markerLuma <= bodyLuma) {
      failures.push(`标记符不比正文淡：亮度 ${markerLuma.toFixed(1)} <= ${bodyLuma.toFixed(1)}`);
    }
    if (report.markerOpacity !== null && report.markerOpacity >= 1) {
      failures.push(`标记符不透明度 ${report.markerOpacity}：没有退淡`);
    }
  }

  // 判据 3：文本一个字符都没少。
  if (report.text !== TEXT) {
    failures.push(
      `文本被改动了：\n  期望 ${JSON.stringify(TEXT)}\n  实际 ${JSON.stringify(report.text)}`,
    );
  }

  // 判据 4：每个偏移都能落光标。
  if (report.reachable !== TEXT.length) {
    failures.push(`光标只能落到 ${report.reachable} 个位置，应为 ${TEXT.length}`);
  }

  // 判据 5：围栏不做行内解析。
  if (report.fenceStrong !== 0) {
    failures.push(`围栏里出现了 ${report.fenceStrong} 处加粗：代码里的 * 被当成了强调`);
  }
  if (!report.fenceText.includes("*ptr * 2;")) {
    failures.push(`围栏文本被改动了：${JSON.stringify(report.fenceText)}`);
  }

  // 判据 6：每一种样式都真的画出来了。只断「有这个 class」会放过缺样式表的
  // 情形——删除线正是这样漏掉的：解析对、class 对、屏幕上没有横线。
  if (report.emphasisStyle === null) {
    failures.push("屏幕上没有 .md-emphasis 元素：斜体没画出来");
  } else if (report.emphasisStyle === "normal") {
    failures.push(`斜体没生效：font-style 是 ${report.emphasisStyle}`);
  }
  if (report.strikeDecoration === null) {
    failures.push("屏幕上没有 .md-strikethrough 元素：删除线没画出来");
  } else if (!report.strikeDecoration.includes("line-through")) {
    failures.push(`删除线没生效：text-decoration-line 是 ${report.strikeDecoration}`);
  }
  if (report.codeFamily === null) {
    failures.push("屏幕上没有 .md-code 元素：行内代码没画出来");
  } else if (!/mono/i.test(report.codeFamily)) {
    failures.push(`行内代码没换等宽字体：font-family 是 ${report.codeFamily}`);
  }

  if (failures.length === 0) {
    console.log(
      `PASS  行内标记画到了屏幕上（加粗字重 ${report.strongWeight} vs 正文 ${report.bodyWeight}，` +
        `${report.markerCount} 处标记符退淡到 opacity ${report.markerOpacity}），` +
        `斜体/删除线/等宽四种样式都已生效，文本与光标不受影响，围栏不受影响`,
    );
  }
} finally {
  await browser?.close();
  server.stop(true);
}

if (failures.length > 0) {
  console.error(`FAIL  verify:inline-marks\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
