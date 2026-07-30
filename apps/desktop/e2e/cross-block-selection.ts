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

  // 拖拽前等排版落定，并**验证落点确实落在文字上**。
  //
  // 这道门禁在全门禁并发负载下失败过两次，两次的形状不同（一次终点落进段落
  // 之间，一次连起点都为 null），共同点是：拖拽发生时页面还没准备好，而失败
  // 消息读起来像产品缺陷。所以这里不再假设「等一下就好」，而是**先用
  // elementFromPoint 确认这两个坐标真的落在目标块上**，不满足就
  // 重试，重试耗尽则报出一条说明是装置而非产品的失败。
  const rectOfText = async (blockId: string) =>
    page.evaluate((id) => {
      const paragraph = document.querySelector(`[data-block-id="${id}"]`);
      const text = paragraph?.firstChild;
      if (text === null || text === undefined) return null;
      const range = document.createRange();
      range.selectNodeContents(text);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    }, blockId);

  const pointHits = async (x: number, y: number, blockId: string) =>
    page.evaluate(
      ({ x, y, id }) => {
        const element = document.elementFromPoint(x, y);
        return element?.closest("[data-block-id]")?.getAttribute("data-block-id") === id;
      },
      { x, y, id: blockId },
    );

  let start: { x: number; y: number } | null = null;
  let end: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < 20 && (start === null || end === null); attempt += 1) {
    const first = await rectOfText("b1");
    const third = await rectOfText("b3");
    if (first !== null && third !== null && first.width > 0 && third.width > 0) {
      const candidateStart = { x: first.x + first.width * 0.2, y: first.y + first.height / 2 };
      const candidateEnd = { x: third.x + third.width * 0.6, y: third.y + third.height / 2 };
      if (
        (await pointHits(candidateStart.x, candidateStart.y, "b1")) &&
        (await pointHits(candidateEnd.x, candidateEnd.y, "b3"))
      ) {
        start = candidateStart;
        end = candidateEnd;
        break;
      }
    }
    await page.waitForTimeout(100);
  }
  if (start === null || end === null) {
    throw new Error(
      "the harness never found two points that land on the first and third paragraphs; " +
        "this is a fixture problem, not a selection problem",
    );
  }

  // 用真实鼠标从第一段拖到第三段。
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
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
