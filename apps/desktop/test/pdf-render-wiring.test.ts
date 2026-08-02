/**
 * PDF 只读渲染的接线与零出网。
 *
 * 钉住的失败：`openPdf` 里「四个取远程资源的入口一个都不传」这条事实，目前
 * 只由一段注释和 `verify:pdf-render` 承担。而那道门禁在没有字形栅格化能力的
 * 机器上量到 0 个着墨像素、直接变红，红的原因与出网无关——也就是说在那种
 * 环境里它既不能证明画对了，也不能证明没出网。
 *
 * 日后任何人「顺手把参数补全」（`cMapUrl: "https://cdn…"` 是 pdf.js 文档里
 * 给的标准写法）都不会有东西变红，而作者只在恰好打开一份用到 CJK 字符映射表
 * 的 PDF 时才会真的发出请求——最难发现的那种失效。
 *
 * 读源码而不是渲染：这条事实本来就写在源码里，量它不需要浏览器，因此也就
 * 不受渲染后端能力的影响。`verify:no-network` 扫的是全仓字面量，它拦得住
 * 写死的网址；这里拦的是另一件事——**把选项传出去**这个动作本身。
 */

import { describe, expect, test } from "bun:test";

const RENDER = "apps/desktop/src/ui/pdf-render.ts";
const SURFACE = "apps/desktop/src/ui/SourceSurface.tsx";

describe("PDF 只读渲染", () => {
  test("四个取远程资源的入口一个都不传", async () => {
    const source = await Bun.file(RENDER).text();
    // 注释里出现这些名字是好事（它解释了为什么不传），所以只看代码：
    // 把注释整段剥掉之后，这些标识符一次都不该出现。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const entry of ["cMapUrl", "standardFontDataUrl", "iccUrl", "wasmUrl"]) {
      expect(code).not.toContain(entry);
    }
  });

  test("传给 getDocument 的只有字节", async () => {
    const source = await Bun.file(RENDER).text();
    // 传 `{ data: bytes }` 之外的任何一项都要重新想一遍出网。
    expect(source).toContain("getDocument({ data: bytes })");
  });

  test("worker 走 blob，不走网址", async () => {
    const source = await Bun.file(RENDER).text();
    // `workerSrc` 指向一个 http(s) 地址就是一条出网路径；blob 同源不发请求。
    // 也不能留空——`PDFWorker.create` 会当场抛错，任何 PDF 都打不开。
    expect(source).toContain("URL.createObjectURL");
    expect(source).toContain("GlobalWorkerOptions.workerSrc");
    expect(source).not.toMatch(/workerSrc\s*=\s*["'`]https?:/);
    expect(source).not.toMatch(/workerSrc\s*=\s*["'`]\s*["'`]/);
  });

  test("面板经端口取字节，不自己跨桥", async () => {
    const source = await Bun.file(SURFACE).text();
    // `verify:component-depth` 拦过一次：组件直接调 `commands.importedSourceBytes`。
    // 组件不得跨桥——外壳把函数传进来，副作用是这个面板可以用替身来测。
    expect(source).not.toContain("commands.");
  });

  test("关掉面板要真的释放解析器", async () => {
    const source = await Bun.file(SURFACE).text();
    // pdf.js 的 `destroy()` 在 loading task 上而不是文档上。只拿文档的调用方
    // 没有任何办法关掉它，于是解析器会一直留着整份 PDF 的内存。
    expect(source).toContain("release");
  });
});
