// 门禁：导入来源的原始页面真的画出来了，且一个字节都不出网。
//
// 为什么只能在浏览器里：pdf.js 要 `DOMMatrix`、`canvas`、`document.fonts`，
// 在 Bun 里 `import` 它当场抛 `ReferenceError: DOMMatrix is not defined`
// （实测）。所以这一层没有单测可言——写在 `packages/editor/test/` 下的任何
// 断言都跑不起来，唯一能证明它工作的地方就是这里。
//
// 判据：
//
// 1. 一份已知的 PDF 打开后页数正确——解析真的发生了。
// 2. 画出来的 canvas 有像素，且**不是全白**。空 canvas 的宽高一样对，
//    所以断尺寸不够：要看到墨。
// 3. `release()` 之后文档不可用——资源真的放掉了，不是个空函数。
// 4. 坏字节被拒绝，而不是静默给一份零页文档。
// 5. **整个过程零外部请求**（INV-1）。用 Playwright 监听 request 事件实测，
//    不是读源码猜。pdf.js 默认从 CDN 取 CJK 字符映射表与标准字体，而那只在
//    作者恰好打开一份用到它们的 PDF 时才触发——最难发现的那种失效。
//
// 注入验红（本轮实测，逐条改一处跑一次）：
// - `renderPage` 不调 `page.render` → 判据 2 红（0 个着墨像素）。
// - `release` 改成空函数 → 判据 3 红（文档仍然可用）。
// - `canvas.width` 写死成 320 → 判据 2 红（画布像素 320×200，应为 400×200）。
//
// 那第三条一开始写死成 **400** 并且不红——这台机器的 `devicePixelRatio` 是 1，
// 400 恰好就是期望值，注入等于什么都没做。注入值必须与期望值不同，否则造出
// 的是同一个世界。同一轮还发现判据 2 原本断的是 `viewport` 算出来的数而不是
// canvas 自己的像素：写死 `canvas.width` 时它照样全绿，因为它读的根本不是
// 屏幕上那块画布。
//
// **判据 5 测不到 `cMapUrl`。** 把它指回 CDN 地址，这道门禁照样全绿——语料是
// 手写的纯 ASCII PDF，用的是内建的 Helvetica，永远走不到取 CJK 字符映射表那
// 条路。要让它有区分力，得有一份真正嵌入 CJK 编码的 PDF，而那份语料手写不
// 出来（CMap 表本身就是它要取的东西）。
//
// 保留判据 5 是因为它守着**别的**东西：worker 必须来自产物内的源码而不是
// 一次网络请求（下面断言 blob 恰好一个），以及渲染路径上任何新增的取用都会
// 在这里现形。但不能假装它覆盖了那四个入口——真正挡住它们的是
// `verify:no-network`（禁止产品代码出现远程 URL 字面量），以及 pdf.js 自身
// 「不传即不取」的行为（`getFactoryUrlProp` 对非字符串返回 null）。
//
// 已记入 ToDo：找一份可分发的 CJK PDF 语料后补齐这条。

import { type Browser, chromium } from "playwright";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

ensureNodeDriver(import.meta.url);

// 打包 PDF 模块自己，不打包整个 editor：PDF 渲染住在应用层（`packages/editor`
// 由 `verify:typeset-purity` 守着零外部依赖），而这道门禁测的就是它。
const bundle = await Bun.build({
  entrypoints: ["apps/desktop/src/ui/pdf-render.ts"],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  throw new Error(`pdf bundle failed: ${bundle.logs.map(String).join("\n")}`);
}
const editorJavaScript = await bundle.outputs[0].text();

// worker 源码：门禁自己按 Bun 的办法取，与应用按 Vite 的办法取是同一份文件。
const workerSource = await Bun.file("node_modules/pdfjs-dist/build/pdf.worker.min.mjs").text();

/**
 * 最小的合法 PDF：一页，一行文字。
 *
 * 手写而不是引一个生成库：这份语料的价值在于它是**已知的**——页数、内容、
 * 页面尺寸都写在这里，判据断言的正是这些已知值。一个生成器会让语料随它的
 * 版本变化，而那时判据还在断言旧的期望。
 */
function minimalPdf(): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 50 Td (RefRain) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const startxref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
const html = `<!doctype html>
<meta charset="utf-8">
<body style="margin:0">
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

  // 判据 5：从载入前就开始记。
  const external: string[] = [];
  const blobs = new Set<string>();
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(`http://127.0.0.1:${server.port}`)) return;
    // `data:` 与 `blob:` 不离开这个进程：前者的内容就在 URL 里，后者是一个
    // 内存对象的同源句柄。pdf.js 的 worker 正是以 blob 形式交付的（源码打进
    // 产物，运行时包成 blob URL），所以它必然出现在这里而不是一次网络请求。
    //
    // 这个豁免是有代价的：一个真的从远处取来的资源如果先被读成 blob，就绕过
    // 了这条判据。挡住那种情形的是 `verify:no-network`（禁止产品代码出现
    // fetch/XHR/远程 import）与这里的「blob 只能来自我们自己创建的那一个」
    // ——下面断言 blob 的数量，多出来的一个就是有人在运行时又造了一个。
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      blobs.add(url);
      return;
    }
    external.push(url);
  });

  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  // worker 必须先装上：`openPdf` 一被调用 pdf.js 就要它。
  await page.evaluate((source: string) => {
    (
      window as unknown as { editorApi: { useWorkerSource(s: string): void } }
    ).editorApi.useWorkerSource(source);
  }, workerSource);

  const bytes = [...minimalPdf()];
  const result = await page.evaluate(async (data: number[]) => {
    const api = window as unknown as {
      editorApi: {
        openPdf(bytes: Uint8Array): Promise<{
          document: { numPages: number; getPage(n: number): Promise<unknown> };
          release(): Promise<void>;
        }>;
        renderPage(
          document_: unknown,
          page: number,
          scale: number,
        ): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }>;
      };
    };
    const opened = await api.editorApi.openPdf(new Uint8Array(data));
    const pages = opened.document.numPages;
    const rendered = await api.editorApi.renderPage(opened.document, 1, 2);

    // 判据 2：数非白像素。空 canvas 的宽高一样对，所以尺寸证明不了画了东西。
    const context = rendered.canvas.getContext("2d");
    const image = context?.getImageData(0, 0, rendered.canvas.width, rendered.canvas.height);
    let inked = 0;
    if (image) {
      for (let index = 0; index < image.data.length; index += 4) {
        const alpha = image.data[index + 3] ?? 0;
        const red = image.data[index] ?? 255;
        if (alpha > 0 && red < 200) inked += 1;
      }
    }

    await opened.release();
    // 判据 3：放掉之后取页必须失败。
    let stillUsable = false;
    try {
      await opened.document.getPage(1);
      stillUsable = true;
    } catch {
      stillUsable = false;
    }

    // 判据 4：坏字节。
    let refusedGarbage = false;
    try {
      await api.editorApi.openPdf(new TextEncoder().encode("这不是 PDF。"));
    } catch {
      refusedGarbage = true;
    }

    return {
      pages,
      // canvas **自己的**像素尺寸，不是 viewport 算出来的那两个数。前者是屏幕
      // 上真实存在的画布，后者只是 pdf.js 的中间结果——实测把 `canvas.width`
      // 写死成 400，断 viewport 的版本照样全绿。
      //
      // 语料的 MediaBox 是 200×100，scale 2 得 400×200，再乘 devicePixelRatio。
      width: rendered.canvas.width,
      height: rendered.canvas.height,
      ratio: window.devicePixelRatio || 1,
      inked,
      stillUsable,
      refusedGarbage,
    };
  }, bytes);

  if (result.pages !== 1) {
    failures.push(`判据 1：页数是 ${result.pages}，语料只有一页——解析没有真的发生`);
  }
  // 语料的 MediaBox 是 200×100，scale 2 得 400×200，画布再按设备像素比放大。
  const expectedWidth = Math.floor(400 * result.ratio);
  const expectedHeight = Math.floor(200 * result.ratio);
  if (result.width !== expectedWidth || result.height !== expectedHeight) {
    failures.push(
      `判据 2：画布像素 ${result.width}×${result.height}，应为 ${expectedWidth}×${expectedHeight}（MediaBox 200×100 × scale 2 × dpr ${result.ratio}）`,
    );
  }
  if (result.inked < 20) {
    failures.push(
      `判据 2：canvas 上只有 ${result.inked} 个着墨像素——页面是空白的，尺寸对不代表画了东西`,
    );
  }
  if (result.stillUsable) {
    failures.push("判据 3：release() 之后文档仍然可用——资源没有真的放掉");
  }
  if (!result.refusedGarbage) {
    failures.push("判据 4：坏字节没有被拒绝——静默给了一份空文档，作者会以为原件是空的");
  }
  if (external.length > 0) {
    failures.push(`判据 5：渲染 PDF 发出了 ${external.length} 个外部请求：${external.join(", ")}`);
  }
  // 只应该有一个 blob：worker 脚本。多出来的说明有人在运行时又造了一个，
  // 而那正是「先取到内存再当本地资源用」的形状。
  if (blobs.size > 1) {
    failures.push(
      `判据 5：出现了 ${blobs.size} 个 blob，只应有 worker 一个：${[...blobs].join(", ")}`,
    );
  }
  if (blobs.size === 0) {
    failures.push(
      "判据 5：一个 blob 都没有——worker 没有按预期从产物内的源码创建，这条判据没测到东西",
    );
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
  "verify:pdf-render PASS — 一页解析正确、400×200 且真的着墨、release 后不可用、坏字节被拒、零出网",
);
