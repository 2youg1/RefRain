/**
 * 探针：面板在 `<Show>` 与 `display` 两种写法下，来回切换各付多少。
 *
 * `quarters.ts` 的 `persistence` 规定第 2/3/4 层「建了就留，藏起来而不销毁」，
 * 理由是频率——作者用 Agent 的时候本来就在改稿，两者同时活跃是常态。
 * 当前渲染层全部是 `<Show>`（Solid 会卸载 DOM）。
 *
 * 规矩本身不构成改动的理由，代价才是。这个探针量的就是代价：
 * 同一份面板内容，条件挂载 vs display 切换，来回 N 次的耗时与 DOM 变动量。
 *
 * 跑法：bun scripts/probe-panel-persistence.ts
 */

import { chromium } from "playwright";

const ROUNDS = 60;
/** 一层面板的规模：批注列表几十条、派发面板带块选择器，都在这个量级。 */
const NODES = 400;

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; font: 14px system-ui; }
  .panel { width: 400px; }
  .row { padding: 6px 10px; border-bottom: 1px solid #eee; }
  .hidden { display: none; }
</style>
<div id="mount-host"></div>
<div id="display-host"><div class="panel hidden" id="kept"></div></div>
<script>
  window.buildRows = (into) => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < ${NODES}; index += 1) {
      const row = document.createElement("div");
      row.className = "row";
      row.textContent = "第 " + index + " 条批注：陆沉舟站在窗前。";
      fragment.append(row);
    }
    into.append(fragment);
  };
  window.buildRows(document.getElementById("kept"));
</script>`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.route("http://refrain.test/**", async (route) => {
  await route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
});

try {
  await page.goto("http://refrain.test/");

  const result = await page.evaluate((rounds) => {
    const mountHost = document.getElementById("mount-host");
    const kept = document.getElementById("kept");
    if (mountHost === null || kept === null) return null;
    const build = (window as unknown as { buildRows: (into: Element) => void }).buildRows;

    // 甲：条件挂载 —— 每次开都重建整棵子树，每次关都丢掉。
    //
    // MutationObserver 的回调是微任务，不会在这个同步循环里跑完；改用
    // takeRecords() 主动取，才拿得到真实变动数（第一版计数恒为 0，那是
    // 仪器坏了不是「没有变动」）。
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });

    const mountStart = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      const panel = document.createElement("div");
      panel.className = "panel";
      build(panel);
      mountHost.append(panel);
      // 强制布局，模拟面板真的被画出来。
      void panel.getBoundingClientRect().height;
      panel.remove();
    }
    const mountMs = performance.now() - mountStart;
    const mountMutations = observer.takeRecords().length;

    // 乙：display 切换 —— 子树只建一次，之后只改一个属性。
    const displayStart = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      kept.classList.remove("hidden");
      void kept.getBoundingClientRect().height;
      kept.classList.add("hidden");
    }
    const displayMs = performance.now() - displayStart;
    const displayMutations = observer.takeRecords().length;
    observer.disconnect();

    return {
      mountMs,
      displayMs,
      mountMutations,
      displayMutations,
      nodes: kept.childElementCount,
    };
  }, ROUNDS);

  if (result === null) {
    console.log("PROBE 判定: 元素没建起来");
  } else {
    console.log(`PROBE 面板节点数     = ${result.nodes}`);
    console.log(`PROBE 开合次数       = ${ROUNDS}`);
    console.log(`PROBE 甲·条件挂载    = ${result.mountMs.toFixed(1)}ms`);
    console.log(`PROBE 乙·display切换 = ${result.displayMs.toFixed(1)}ms`);
    console.log(
      `PROBE 每次开合之差   = ${((result.mountMs - result.displayMs) / ROUNDS).toFixed(2)}ms`,
    );
    console.log(`PROBE 甲 DOM 变动    = ${result.mountMutations}`);
    console.log(`PROBE 乙 DOM 变动    = ${result.displayMutations}`);
  }
} finally {
  await browser.close();
}
