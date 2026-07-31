#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
/**
 * 版面对比页：把几套候选版面放在同一张纸上，让人用眼睛裁决。
 *
 * 三条纪律写在这里，因为它们是这份工件成立的条件：
 *
 * 1. **用真实变量。** 页面直接引 `themes.css` 与 `fonts.css`，不复制色值、不重打
 *    字体栈。抄一份色值过来的对比页，比较的是抄写的准确度，不是设计。
 * 2. **同一段稿子。** 四套版面渲染同一篇中日西混排的手稿，差别才只剩版面本身。
 * 3. **进仓库再请人看。** 上一版九档主题预览页从未提交，选定的七套色值随工作区
 *    清理永久丢失。工件与生成它的脚本必须先落盘。
 *
 * 用法：bun scripts/generate-layout-preview.ts && 打开 ../review/layout-preview.html
 */

import { join } from "node:path";

/*
 * 审阅件写到仓库之外，避免成为第二权威。
 */
const REVIEW_DIR = process.env.REFRAIN_REVIEW_DIR ?? join(import.meta.dir, "..", "..", "review");
const OUT = join(REVIEW_DIR, "layout-preview.html");

/** 四套候选。差别在「作者的视野被什么占据」，不在装饰。 */
const LAYOUTS = [
  {
    id: "current",
    name: "甲 · 现状",
    thesis: "侧栏 264px 常驻可收起，正文居中，状态条 26px。",
    note: "作为对照存在：任何一套新版面都要比它更让人愿意久坐。",
  },
  {
    id: "quiet",
    name: "乙 · 退到边上",
    thesis: "侧栏默认收起，只留 6px 感应窄条；正文占满，页边给到 12vh。",
    note: "赌注是作者九成时间在写而非在找文件。代价：切文档要多一个动作。版心最宽，长行中文最从容。",
  },
  {
    id: "column",
    name: "丙 · 双栏并置",
    thesis: "正文固定居左偏中，右侧常驻一条 320px 的参考栏（批注/资料/提案共用）。",
    note: "为「一边写一边对照」设计。代价已实测：左 264 + 右 320 吃掉近一半窗宽，版心只剩约 28 字/行（中文舒适区 30–40），第一段末尾已出现「具。」这样的孤字；参考栏在只有三条批注时约四成是空的。",
  },
  {
    id: "paper",
    name: "丁 · 纸张感",
    thesis: "正文置于一张有边界的纸上，纸外是桌面色；侧栏与纸同层不覆盖。",
    note: "把「文件」变回「一页纸」。三处待解已实测：纸与桌面只差约 5 个 L*，弱光或低色准屏上纸会化进桌面；纸的左右留白 130px 而上下只有 25/11px，读起来像被裁掉上下的纸；版心 544px 约 30 字，窗口窄于 1100px 就不成立。若采用，需给纸加实体描边与对称留白，不能只靠明度差。",
  },
] as const;

const SPECIMEN = `<h2>第三章　停留</h2>
<p>写作是把尚未成形的东西按住，让它在纸面上停留得够久，久到可以被看清。这件事没有捷径，也没有一个能替你按住它的工具。</p>
<p>推敲の余地は、書いた本人にしか見えない。The quick brown fox jumps over the lazy dog, and the sentence keeps its shape.</p>
<blockquote>文章千古事，得失寸心知。</blockquote>
<p>所以工具能做的只有一件事：不要在他按住那个东西的时候，把他的注意力拿走。</p>`;

const THEMES = [
  ["tou", "濤"],
  ["kasumi", "霞"],
  ["suna", "砂"],
  ["hua", "桦"],
  ["wabi", "侘"],
  ["sumi", "墨"],
  ["shao", "韶"],
] as const;

const page = `<!doctype html>
<html lang="zh-Hans" data-theme="tou">
<head>
<meta charset="utf-8">
<title>RefRain · 版面对比</title>
<link rel="stylesheet" href="../apps/desktop/src/fonts.css">
<link rel="stylesheet" href="../apps/desktop/src/themes.css">
<style>
  /* 对比页自己的骨架。手稿的排版一律读 --manuscript-* 与主题变量，不自定义。 */
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper-sunk);
    color: var(--ink);
    font-family: "Jost", var(--sans, sans-serif);
    --manuscript-family: "Noto Sans SC", "Zen Kaku Gothic New", serif;
    --manuscript-size: 17px;
    --manuscript-leading: 1.95;
    --manuscript-tracking: 0.01em;
    --manuscript-measure: 32em;
    --manuscript-indent: 2em;
    --paragraph-gap: 0.9em;
  }
  header.bar {
    position: sticky; top: 0; z-index: 30;
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
    padding: 12px 20px;
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
  }
  header.bar h1 { font-size: 15px; font-weight: 400; letter-spacing: 0.2em; margin: 0; }
  .swatches { display: flex; gap: 6px; }
  .swatches button {
    width: 26px; height: 26px; border-radius: 3px; cursor: pointer;
    border: 1px solid var(--rule-strong); font-size: 11px; color: inherit;
    background: transparent;
  }
  .swatches button[aria-pressed="true"] { box-shadow: inset 0 0 0 2px var(--seal); }
  .hint { color: var(--ink-faint); font-size: 12px; }

  section.candidate { padding: 26px 20px 40px; }
  .caption { max-width: 62em; margin: 0 auto 14px; }
  .caption h2 { font-size: 16px; margin: 0 0 4px; letter-spacing: 0.06em; }
  .caption p { margin: 0 0 3px; font-size: 13px; color: var(--ink-soft); }
  .caption .note { color: var(--ink-faint); font-size: 12px; }

  /* 一个窗口的等比缩影：38px 窗口栏 + 正文 + 26px 状态条。 */
  .window {
    max-width: 1180px; margin: 0 auto; height: 560px;
    border: 1px solid var(--rule-strong); border-radius: 4px; overflow: hidden;
    display: grid; grid-template-rows: 38px 1fr 26px;
    background: var(--paper);
    box-shadow: 0 18px 48px color-mix(in oklab, var(--ink) 14%, transparent);
  }
  .chrome { display: flex; align-items: center; padding: 0 14px; border-bottom: 1px solid var(--rule);
            font-size: 12px; color: var(--ink-faint); letter-spacing: 0.1em; }
  .status { display: flex; align-items: center; gap: 14px; padding: 0 14px;
            border-top: 1px solid var(--rule); font-size: 11px; color: var(--ink-faint); }
  .body { position: relative; display: flex; min-height: 0; }

  .rail {
    width: 264px; flex: none; padding: 16px 12px; overflow-y: auto;
    background: var(--rail); color: var(--rail-ink); border-right: 1px solid var(--rail-rule);
  }
  .rail .group { font-size: 10px; letter-spacing: 0.24em; color: var(--rail-faint); padding: 10px 8px 4px; }
  .rail .row { padding: 7px 10px; font-size: 13px; color: var(--rail-faint); border-left: 2px solid transparent; }
  .rail .row.current { color: var(--rail-ink); border-left-color: var(--seal); }

  .strip { width: 6px; flex: none; background: color-mix(in oklab, var(--rail) 55%, transparent); }

  .stage { flex: 1; min-width: 0; overflow-y: auto; padding: 40px 0; }
  .manuscript {
    width: min(var(--manuscript-measure), calc(100% - 96px)); margin: 0 auto;
    font-family: var(--manuscript-family); font-size: var(--manuscript-size);
    line-height: var(--manuscript-leading); letter-spacing: var(--manuscript-tracking);
  }
  .manuscript h2 { font-size: 1.15em; font-weight: 500; letter-spacing: 0.08em; margin: 0 0 1.2em; }
  .manuscript p { margin: 0 0 var(--paragraph-gap); text-indent: var(--manuscript-indent); }
  .manuscript blockquote { margin: 0 0 var(--paragraph-gap); padding-left: 1em;
    border-left: 2px solid color-mix(in oklab, var(--seal) 55%, transparent); color: var(--ink-soft); }

  /* 乙 · 退到边上 */
  [data-layout="quiet"] .rail { display: none; }
  [data-layout="quiet"] .stage { padding: 12vh 0; }

  /* 丙 · 双栏并置 */
  [data-layout="column"] .aside {
    width: 320px; flex: none; border-left: 1px solid var(--rule);
    padding: 22px 18px; background: var(--paper-raised); overflow-y: auto;
  }
  [data-layout="column"] .aside h3 { font-size: 11px; letter-spacing: 0.2em; color: var(--ink-faint);
    margin: 0 0 12px; font-weight: 400; }
  [data-layout="column"] .aside .card { border: 1px solid var(--rule); border-radius: 3px;
    padding: 10px 12px; margin-bottom: 10px; font-size: 12.5px; color: var(--ink-soft); line-height: 1.7; }

  /* 丁 · 纸张感 */
  [data-layout="paper"] .body { background: var(--paper-sunk); }
  [data-layout="paper"] .stage { padding: 26px 0; }
  [data-layout="paper"] .manuscript {
    background: var(--lamp); padding: 52px 56px; border-radius: 2px;
    width: min(calc(var(--manuscript-measure) + 112px), calc(100% - 72px));
    box-shadow: 0 6px 22px color-mix(in oklab, var(--ink) 12%, transparent);
  }
  [data-layout="paper"] .rail { background: var(--paper-raised); color: var(--ink);
    border-right: 1px solid var(--rule); }
  [data-layout="paper"] .rail .row { color: var(--ink-faint); }
  [data-layout="paper"] .rail .row.current { color: var(--ink); border-left-color: var(--seal); }
  [data-layout="paper"] .rail .group { color: var(--ink-ghost); }
</style>
</head>
<body>
<header class="bar">
  <h1>RefRain · 版面对比</h1>
  <div class="swatches" id="themes">
    ${THEMES.map(([id, label]) => `<button type="button" data-theme-id="${id}" aria-pressed="${id === "tou"}">${label}</button>`).join("\n    ")}
  </div>
  <span class="hint">同一段稿子，四套版面。色与字体读的是产品真实的 themes.css / fonts.css。</span>
</header>

${LAYOUTS.map(
  (layout) => `<section class="candidate">
  <div class="caption">
    <h2>${layout.name}</h2>
    <p>${layout.thesis}</p>
    <p class="note">${layout.note}</p>
  </div>
  <div class="window" data-layout="${layout.id}">
    <div class="chrome">第三章　停留 — RefRain</div>
    <div class="body">
      ${layout.id === "quiet" ? '<div class="strip"></div>' : ""}
      <nav class="rail">
        <div class="group">原稿</div>
        <div class="row">第一章　起</div>
        <div class="row">第二章　承</div>
        <div class="row current">第三章　停留</div>
        <div class="row">第四章　转</div>
        <div class="group">资料</div>
        <div class="row">访谈记录 01</div>
        <div class="row">年表草稿</div>
      </nav>
      <main class="stage">
        <article class="manuscript">${SPECIMEN}</article>
      </main>
      ${
        layout.id === "column"
          ? `<aside class="aside">
        <h3>批注</h3>
        <div class="card">这一段的「按住」用了两次，第二次可以换掉。</div>
        <div class="card">引文出处需要补。</div>
        <h3 style="margin-top:22px">提案</h3>
        <div class="card">Agent 建议把第二段拆成两句。</div>
      </aside>`
          : ""
      }
    </div>
    <div class="status"><span>已保存</span><span>选中 12 字</span><span style="margin-left:auto">第三章　停留.md</span></div>
  </div>
</section>`,
).join("\n")}

<script>
  const root = document.documentElement;
  document.getElementById("themes").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-theme-id]");
    if (!button) return;
    root.dataset.theme = button.dataset.themeId;
    for (const other of document.querySelectorAll("#themes button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
</script>
</body>
</html>
`;

writeFileSync(OUT, page);
console.log(`wrote ${OUT} (${LAYOUTS.length} layouts x ${THEMES.length} themes)`);
