// 门禁：作者用鼠标从一段拖到另一段，选区必须成立。
//
// 这是作者每天都做的动作。它此前不成立：每段各自 contentEditable，等于每段
// 自成一个编辑宿主，浏览器会把离开宿主的拖拽收回去——实测选区塌回起始段，
// 选中文本只剩第一段的尾巴。整篇改为单一编辑宿主后才成立。
//
// 必须是真实鼠标拖拽。程序化 `selection.setBaseAndExtent` 在旧结构下也能造出
// 跨块 Range（既有 editor-context 门禁正是那样，所以它一直绿），造得出不等于
// 拖得出——这条门禁问的是后者。

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

  const failures: string[] = [];
  if (report.anchorBlockId !== "b1") {
    failures.push(`the drag started outside the first block (anchor ${report.anchorBlockId})`);
  }
  if (report.focusBlockId !== "b3") {
    failures.push(
      `dragging to the third block left the selection in ${report.focusBlockId}: it collapsed at the block boundary`,
    );
  }
  if (!report.text.includes("第二段") || !report.text.includes("第三段")) {
    failures.push(
      `the selection did not span the paragraphs it crossed: ${JSON.stringify(report.text)}`,
    );
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  console.log("PASS  a mouse drag selects across paragraph boundaries");
} finally {
  await browser?.close();
  server.stop(true);
}
