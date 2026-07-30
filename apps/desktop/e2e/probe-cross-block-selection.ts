// 探针：跨段拖选在当前实现下是否成立。
//
// 设计文档 §2 断言「每段各自 contentEditable 使跨段选区在浏览器层面不成立」。
// 这是关于浏览器行为的经验命题，不是读代码能定论的事——所以先量，再改。

import { type Browser, chromium } from "playwright";

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
const html = `<!doctype html>
<meta charset="utf-8">
<style>body{margin:0} #editor{font:16px/1.6 system-ui}</style>
<div id="editor"></div>
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
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  await page.evaluate(() => {
    const api = window as unknown as {
      editorApi: {
        mountEditor(
          element: HTMLElement,
          document: { revision: string; blocks: Array<{ id: string; text: string }> },
          port: { submit: (action: unknown) => void },
        ): unknown;
      };
      handle: unknown;
    };
    api.handle = api.editorApi.mountEditor(
      document.getElementById("editor") as HTMLElement,
      {
        revision: "r1",
        blocks: [
          { id: "b1", text: "第一段的文字在这里。" },
          { id: "b2", text: "第二段的文字在这里。" },
          { id: "b3", text: "第三段的文字在这里。" },
        ],
      },
      { submit: () => undefined },
    );
  });

  // 用真实鼠标从第一段中部拖到第三段中部。
  const first = await page.locator('[data-block-id="b1"]').boundingBox();
  const third = await page.locator('[data-block-id="b3"]').boundingBox();
  if (first === null || third === null) throw new Error("blocks did not render");
  await page.mouse.move(first.x + 20, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + 60, third.y + third.height / 2, { steps: 12 });
  await page.mouse.up();

  const report = await page.evaluate(() => {
    const selection = document.getSelection();
    const anchorBlock = (selection?.anchorNode as Element | null)?.parentElement?.closest?.(
      "[data-block-id]",
    );
    const focusBlock = (selection?.focusNode as Element | null)?.parentElement?.closest?.(
      "[data-block-id]",
    );
    return {
      text: selection?.toString() ?? "",
      rangeCount: selection?.rangeCount ?? 0,
      anchorBlockId: anchorBlock?.getAttribute("data-block-id") ?? null,
      focusBlockId: focusBlock?.getAttribute("data-block-id") ?? null,
    };
  });

  console.log(JSON.stringify(report, null, 2));
  console.log(
    report.anchorBlockId === "b1" && report.focusBlockId === "b3"
      ? "CROSS-BLOCK SELECTION HOLDS"
      : "CROSS-BLOCK SELECTION COLLAPSES",
  );
} finally {
  await browser?.close();
  server.stop(true);
}
