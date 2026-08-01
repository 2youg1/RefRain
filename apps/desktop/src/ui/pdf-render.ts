/**
 * PDF 的只读渲染：把一页 PDF 画进 canvas。
 *
 * # 只渲染，不写回
 *
 * 所有者裁定：DOCX/EPUB/PDF 的**写入一律不做**。理由在 PDF 上尤其硬——
 * `crates/refrain-store/src/ingest/pdf.rs` 的 `extract` 抽的是文本，字形位置、
 * 字体嵌入、页面盒子全不进内存，往回写等于用一份残缺的模型覆盖原文件。
 *
 * 所以这里画出来的 PDF 是**参照物**：作者一边看原版面，一边在自己的手稿里
 * 写。RefRain 永远不改那个 PDF 文件。
 *
 * # 零出网（INV-1）
 *
 * pdf.js 有四个会取远程资源的入口：`cMapUrl`（CJK 字符映射表）、
 * `standardFontDataUrl`（十四款标准字体）、`iccUrl`（色彩配置）、`wasmUrl`。
 * **这四个都没有默认值**：`getFactoryUrlProp` 对非字符串返回 null，于是不传
 * 就等于不取。所以这里什么都不传，而不是传一个「空」的值。
 *
 * 先前这里传了 `cMapUrl: ""` 之类，读起来像是把入口关严了，实际上
 * `getFactoryUrlProp` 对空串会**抛异常**（"must include trailing slash"）——
 * 任何 PDF 都打不开。那段代码同时是错的和多余的，而它读上去比正确写法更
 * 像在防护。这是我对第三方库的行为凭印象下断言，而不是去读它的判断。
 *
 * 零出网由 `verify:pdf-render` 用 Playwright 监听 request 事件实测，不靠
 * 这段注释。
 */

import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist";

/**
 * 交出 worker 的源码，这个模块把它包成 blob URL 交给 pdf.js。
 *
 * 为什么由调用方给：pdf.js 一定要一个 worker（`#isWorkerDisabled` 是它的私有
 * 状态，浏览器里外部关不掉；`workerSrc` 留空会让 `PDFWorker.create` 当场抛错
 * ——先前设成 `""` 的写法读上去像「不用 worker」，实际是任何 PDF 都打不开）。
 * 而「怎么把一份 `.mjs` 变成字符串」是**构建器**的事：Bun 用
 * `with { type: "text" }`，Vite 用 `?raw`，两者互不认识。这个包不该知道自己
 * 被谁打包，所以由调用方按自己的构建器取来源码，这里只负责用。
 *
 * blob 是同源的，不发请求，也不依赖任何文件在磁盘上的位置——零出网（INV-1）
 * 在这里的形态。
 */
export function useWorkerSource(source: string): void {
  GlobalWorkerOptions.workerSrc = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" }),
  );
}

/** 一页的渲染结果。 */
export interface RenderedPage {
  readonly canvas: HTMLCanvasElement;
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 一份打开着的 PDF，连同关掉它的办法。
 *
 * 早先 `openPdf` 还传了 `isEvalSupported: false`（PDF 可以内嵌 JavaScript）。pdf.js 6
 * 的类型里**已经没有这个选项**——它在这一版被移除，因为渲染路径不再用 `eval`。
 * 传一个不存在的选项不会报错，只会被忽略，那正是「看起来加了防护而其实没有」
 * 的形状；类型检查当场拒绝了它，所以这里如实不传。
 */
export interface OpenedPdf {
  /** 页数与取页都在这上面。 */
  readonly document: PDFDocumentProxy;
  /**
   * 释放解析器持有的资源。
   *
   * `destroy()` 在 loading task 上而不是文档上，所以两个都要留住——只拿文档
   * 的调用方没有任何办法关掉它。
   */
  readonly release: () => Promise<void>;
}

export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  // 四个取远程资源的入口一个都不传：不传即不取（见上）。传任何字符串都是
  // 在开一条出网路径，而它只在作者恰好打开一份用到该资源的 PDF 时才触发
  // ——最难发现的那种失效。
  const task: PDFDocumentLoadingTask = getDocument({ data: bytes });
  return { document: await task.promise, release: () => task.destroy() };
}

/**
 * 画一页。
 *
 * `scale` 由调用方按版心宽度算，这样 PDF 的宽度跟着编辑器的版心走而不是
 * 固定像素——作者调窄版心时 PDF 一起变窄。
 */
export async function renderPage(
  document_: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<RenderedPage> {
  const page = await document_.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  // 按设备像素比放大再用 CSS 缩回去，否则高分屏上是糊的。
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("canvas 2d context unavailable");
  if (ratio !== 1) context.scale(ratio, ratio);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return { canvas, pageNumber, width: viewport.width, height: viewport.height };
}
