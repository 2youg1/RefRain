// 门禁：图表围栏真的画成了 SVG，且源码没被吞掉、光标不进图里。
//
// 为什么必须在真浏览器里：`diagram-render.test.ts` 测的是转换与库调用——喂进去
// 什么、吐出来什么字符串。它全绿不意味着屏幕上有一张图：SVG 塞进 innerHTML 后
// 可能宽高为 0、可能被 CSS 藏起来、可能压根没挂到 DOM 上。这个项目已经踩过
// 「数据层全绿、屏幕上什么也没有」三次（零宽 Highlight 画不出像素是最近一次）。
//
// 判据：
//
// 1. SVG 真的有像素——宽高都大于 0。断几何而不是「有没有 <svg> 元素」：
//    innerHTML 设进去了但父容器 display:none 时，元素断言照绿而人眼看不到。
// 2. 图里的节点文字都出现了——转换链任何一环丢字都在这里露馅。
// 3. 源码原样留在段落里，`textContent` 逐字节不变——图是旁挂的，不是替换。
// 4. 光标不能落进 SVG（`contentEditable=false`），但能落在源码上。
// 5. Mermaid 语法与 nomnoml 语法都画得出来——转换层真的在役。
// 6. 画不出来的图种保留原文，不留下一张过期的图。
// 7. SVG 不发任何网络请求（INV-1）——用 Playwright 的 request 事件实测，
//    不是读源码猜。
//
// 注入验红（本轮实测，逐条改一处跑一次，报错文字各不相同）：
// - `#renderDiagram` 不 `paragraph.after(host)` → 判据 1 红。
// - `#fenceBody` 不剥 ``` → 判据 1、2 红（nomnoml 抛语法错，退回 unsupported）。
// - `host.contentEditable` 设成 "true" → 判据 4 红。
// - `renderDiagram` 里 mermaid 分支不转换直接喂原文 → 判据 5 红。
// - `unsupported` 时不 `mounted?.remove()` → 判据 6 红。

import { type Browser, chromium } from "playwright";
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

/** Mermaid 语法——经转换层。 */
const MERMAID = [
  "```mermaid",
  "graph TD",
  "  A[作者] --> B[编辑视图]",
  "  B -->|裁决| C[手稿字节]",
  "  D[Agent] -.-> C",
  "```",
].join("\n");

/** nomnoml 原生语法——不经转换层。 */
const NOMNOML = ["```nomnoml", "[提案] -> [账本]", "[账本] -> [正文]", "```"].join("\n");

/** 转换不了的图种——必须保留原文。 */
const UNSUPPORTED = ["```mermaid", "sequenceDiagram", "  甲->>乙: 你好", "```"].join("\n");

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  .editor-host {
    --ink: #19345c;
    --ink-soft: #405d89;
    --paper-raised: #f9f3e7;
    --rule: #dcd4c2;
    --font-sans: "Noto Sans SC", sans-serif;
  }
  #editor { font: 16px/1.9 "Noto Sans SC", sans-serif; width: 800px; color: var(--ink); }
  .editor-host .md-diagram {
    display: block; padding: 0.8rem; background: var(--paper-raised);
    border: 1px solid var(--rule); overflow-x: auto;
  }
  .editor-host .md-diagram svg { display: block; max-width: 100%; height: auto; }
</style>
<div class="editor-host"><div id="editor"></div></div>
<script type="module">
  import * as editor from "/editor.js";
  window.editorApi = editor;
</script>`;

// await 不能省：Windows 上 node-gate 的 Bun.serve 替身是 async 的。
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

  // 判据 7：从挂载前就开始记，图表渲染期间不能有任何对外请求。
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`http://127.0.0.1:${server.port}`) && !url.startsWith("data:")) {
      external.push(url);
    }
  });

  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  await page.evaluate(
    ([mermaid, nomnomlSource, unsupported]) => {
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
            { id: "m1", text: mermaid as string, isFence: true },
            { id: "n1", text: nomnomlSource as string, isFence: true },
            { id: "u1", text: unsupported as string, isFence: true },
          ],
        },
        { submit: () => undefined },
      );
    },
    [MERMAID, NOMNOML, UNSUPPORTED],
  );
  // 图表渲染在渲染循环里，等一帧。
  await page
    .waitForFunction(() => document.querySelectorAll(".md-diagram").length >= 2, {
      timeout: 5000,
    })
    .catch(() => undefined);

  // 判据 1 + 5：两种语法都画出了有像素的 SVG。
  const diagrams = await page.evaluate(() => {
    return [...document.querySelectorAll(".md-diagram")].map((host) => {
      const svg = host.querySelector("svg");
      const box = svg?.getBoundingClientRect();
      return {
        blockId: (host as HTMLElement).dataset.diagramFor ?? null,
        hasSvg: svg !== null,
        width: Math.round(box?.width ?? 0),
        height: Math.round(box?.height ?? 0),
        text: svg?.textContent ?? "",
        editable: (host as HTMLElement).isContentEditable,
      };
    });
  });

  const mermaidDiagram = diagrams.find((entry) => entry.blockId === "m1");
  const nomnomlDiagram = diagrams.find((entry) => entry.blockId === "n1");

  if (!mermaidDiagram) {
    failures.push("判据 5：Mermaid 围栏没有画出图——转换层没在役");
  } else if (!mermaidDiagram.hasSvg || mermaidDiagram.width <= 0 || mermaidDiagram.height <= 0) {
    failures.push(
      `判据 1：Mermaid 图没有像素（svg=${mermaidDiagram.hasSvg}, ${mermaidDiagram.width}×${mermaidDiagram.height}）`,
    );
  } else {
    // 判据 2：节点文字都在。
    for (const label of ["作者", "编辑视图", "手稿字节", "Agent"]) {
      if (!mermaidDiagram.text.includes(label)) {
        failures.push(`判据 2：图里找不到节点「${label}」——转换链丢了字`);
      }
    }
  }

  if (!nomnomlDiagram) {
    failures.push("判据 5：nomnoml 围栏没有画出图");
  } else if (!nomnomlDiagram.hasSvg || nomnomlDiagram.width <= 0 || nomnomlDiagram.height <= 0) {
    failures.push(`判据 1：nomnoml 图没有像素（${nomnomlDiagram.width}×${nomnomlDiagram.height}）`);
  }

  // 判据 3：源码原样留在段落里。
  const sources = await page.evaluate(() => ({
    m1: document.querySelector("[data-block-id='m1']")?.textContent ?? null,
    n1: document.querySelector("[data-block-id='n1']")?.textContent ?? null,
    u1: document.querySelector("[data-block-id='u1']")?.textContent ?? null,
  }));
  for (const [id, expected] of [
    ["m1", MERMAID],
    ["n1", NOMNOML],
    ["u1", UNSUPPORTED],
  ] as const) {
    const actual = sources[id];
    if (actual !== expected) {
      failures.push(
        `判据 3：块 ${id} 的源码被动过——渲染 ${actual?.length ?? 0} 字节，源 ${expected.length} 字节。图是旁挂的，不该替换源码`,
      );
    }
  }

  // 判据 4：图不进编辑坐标系。
  for (const diagram of diagrams) {
    if (diagram.editable) {
      failures.push(`判据 4：块 ${diagram.blockId} 的图可编辑——光标会落进 SVG 里`);
    }
  }

  // 判据 6：画不出来的图种没有留下图。
  const unsupportedHasDiagram = await page.evaluate(() => {
    const paragraph = document.querySelector("[data-block-id='u1']");
    const next = paragraph?.nextElementSibling;
    return next instanceof HTMLElement && next.classList.contains("md-diagram");
  });
  if (unsupportedHasDiagram) {
    failures.push("判据 6：sequenceDiagram 画不出来却挂了一张图——那是张过期或错误的图");
  }

  // 判据 7：零出网。
  if (external.length > 0) {
    failures.push(`判据 7：图表渲染发出了 ${external.length} 个外部请求：${external.join(", ")}`);
  }

  // 断样本数：三个块都没渲染时上面多数判据会静默通过。
  if (diagrams.length < 2) {
    failures.push(`断样本数：只渲染出 ${diagrams.length} 张图，语料有 2 张可画——判据形同虚设`);
  }
} finally {
  await browser?.close();
  server.stop(true);
}

if (failures.length > 0) {
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
console.log(
  "verify:diagram-render PASS — Mermaid 与 nomnoml 两种语法各画出一张有像素的图、源码逐字节保留、光标不进图、不支持的图种保留原文、零出网",
);
