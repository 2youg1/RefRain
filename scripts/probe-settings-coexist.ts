#!/usr/bin/env bun
/**
 * 探针：设置层开着的时候，作者还看不看得见自己的字。
 *
 * 四区规矩说设置是第 1 层、正文在它之上，作者改字号时理应看得见效果。
 * `takesWholeStage` 已经改成只有裁决占满舞台，源码测试也钉住了两个方向——
 * 但那只证明了一个布尔值。**样式表有没有跟上是另一回事**：`.settings` 是
 * `height:100%` 加不透明的 `var(--paper)` 背景，仅仅让它别被 display:none
 * 掉，它会盖住正文而不是与之并存。
 *
 * 所以这个探针用产品真实的 surfaces.css 量几何，断言的是**关系**不是数值：
 * 「设置的矩形与正文的矩形不重叠」在任何视口下都必须成立，而
 * 「设置宽度 == 400」在坏世界里照样绿。
 *
 * 这是探针不是门禁：它报告当前实况，供判断改样式表要改到什么程度。
 */

import { chromium } from "playwright";

const build = Bun.spawnSync(["bun", "run", "build:web"], { stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) {
  console.error(new TextDecoder().decode(build.stderr));
  process.exit(build.exitCode);
}

const css = await Bun.file("apps/desktop/src/styles/surfaces.css").text();

// 舞台里同时放设置与正文，用产品自己的类名与结构。
// 结构照抄 Workbench：设置是 stage-row 的子元素，与其他面板同级。
const html = `<!doctype html><meta charset="utf-8">
<style>
:root { --paper:#f4f1ea; --paper-raised:#faf8f3; --ink:#1f1d1a; --seal-wash:#c8552f;
        --lamp:#fff; --lamp-glow:#fff; --shade:#000;
        --panel-reserve:400px; --panel-width:400px; --panel-offset:0px;
        --chrome-height:0px; --status-height:0px; }
html,body { margin:0; height:100%; }
${css}
</style>
<main class="stage" style="height:100vh">
  <div class="stage-row" id="row" data-panels="open" style="position:relative">
    <div class="lamp-layer" aria-hidden="true"></div>
    <div class="editor-wrap"><div class="editor-host" id="manuscript">正文第一段。</div></div>
    <section class="settings" data-quarter="settings" id="settings"><div class="settings-frame">设置</div></section>
  </div>
</main>`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.route("http://refrain.test/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/") {
    await route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
    return;
  }
  // 字体等资源不参与几何判断，直接放行成空响应免得卡住加载。
  await route.fulfill({ status: 200, body: "" });
});

try {
  await page.goto("http://refrain.test/");
  const boxes = await page.evaluate(() => {
    const read = (id: string) => {
      const element = document.getElementById(id);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        display: style.display,
        position: style.position,
        background: style.backgroundColor,
        zIndex: style.zIndex,
      };
    };
    return { settings: read("settings"), manuscript: read("manuscript") };
  });

  console.log("PROBE settings   =", JSON.stringify(boxes.settings));
  console.log("PROBE manuscript =", JSON.stringify(boxes.manuscript));

  const settings = boxes.settings;
  const manuscript = boxes.manuscript;
  if (settings === null || manuscript === null) {
    console.log("PROBE 判定: 有元素没渲染出来");
  } else {
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const visible = manuscript.width > 0 && manuscript.height > 0;
    // 关系断言之一：两个矩形不重叠。写成 width===400 那种在坏世界里照样绿。
    const overlaps =
      settings.right > manuscript.left &&
      settings.left < manuscript.right &&
      settings.bottom > manuscript.top &&
      settings.top < manuscript.bottom;
    // 关系断言之二，也是真正要问的那个：正文有没有一部分落在视口里。
    //
    // 只问「不重叠」会得到一个骗人的绿：设置若占满整个舞台高度，正文被推到
    // 视口下方一千像素处，两个矩形确实不重叠，而作者一个字也看不见。
    // 实测第一版探针就是这么答的——「并存成立」，但正文 top=1016，视口只有 860。
    const onScreen =
      manuscript.top < viewport.height &&
      manuscript.bottom > 0 &&
      manuscript.left < viewport.width &&
      manuscript.right > 0;
    console.log(`PROBE 视口         = ${viewport.width}x${viewport.height}`);
    console.log(`PROBE 正文有尺寸   = ${visible}`);
    console.log(`PROBE 两者重叠     = ${overlaps}`);
    console.log(`PROBE 正文在视口内 = ${onScreen}`);
    const verdict = !visible
      ? "正文不可见"
      : overlaps
        ? "正文被设置盖住"
        : onScreen
          ? "并存成立"
          : "正文被挤出视口——不重叠，但作者依然看不见";
    console.log(`PROBE 判定: ${verdict}`);
  }
} finally {
  await browser.close();
}
