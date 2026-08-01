#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { ensureNodeDriver } from "./pw-chromium.ts";

ensureNodeDriver(import.meta.url);

import { type LampKind, lampFacing, lampPlacement } from "../apps/desktop/src/shell/lamp";

/*
 * 审阅件写到仓库之外，避免成为第二权威。
 */
const REVIEW_DIR = process.env.REFRAIN_REVIEW_DIR ?? join(import.meta.dir, "..", "..", "review");
const OUT = join(REVIEW_DIR, "panel-preview");
const THEMES = ["tou", "sumi"] as const;
const MATERIALS = ["solid", "acrylic", "liquid"] as const;
/** 两盏灯：单侧（挂面板那边，光横穿舞台）与全侧（挂头顶，自上而下柔光）。 */
const LAMPS = ["off", "side", "overhead"] as const;

/** 三档材质的规格，与 shell/panel-material.ts 同一组数字。 */
const SPEC = {
  solid: { blur: 0, saturate: 1, opacity: 1, rim: 0 },
  acrylic: { blur: 20, saturate: 1.4, opacity: 0.72, rim: 0.18 },
  liquid: { blur: 12, saturate: 1.8, opacity: 0.52, rim: 0.42 },
} as const;

/*
 * 灯的位置来自 shell/lamp.ts——预览必须问真模块，不能自己编一套。
 *
 * 这一条是查「两盏灯看不出区别」时挖出来的：预览页手写 data-lamp 和一串行内变量，
 * 完全绕过 applyAppearance，于是无论产品里的灯怎么改，预览渲染出来的都是旧样子。
 * 一张不走真代码路径的预览图，证明不了任何关于产品的事。
 */
const lampVars = (kind: string): string => {
  const place = lampPlacement(kind as LampKind, "left");
  if (!place) return "";
  return [
    `--lamp-x:${place.x * 100}%`,
    `--lamp-y:${place.y * 100}%`,
    `--lamp-reach:${place.reach * 100}%`,
    `--lamp-power:${place.power}`,
    `--lamp-facing:${lampFacing(place)}`,
  ].join(";");
};

const page = (theme: string, material: keyof typeof SPEC, lamp: string) => {
  const spec = SPEC[material];
  return `<!doctype html>
<html lang="zh-Hans" data-theme="${theme}" data-paper="paper" data-lamp="${lamp}" data-panel-side="left"
      style="--panel-blur:${spec.blur}px;--panel-saturate:${spec.saturate};--panel-opacity:${spec.opacity};--panel-rim:${spec.rim};--panel-motion:300ms;--panel-easing:cubic-bezier(0.16,0.84,0.34,1);--panel-enter-from:-100%;${lampVars(lamp)}">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/themes.css">
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/surfaces.css">
<style>
  body { margin: 0; background: var(--paper-sunk); }
  .stage-row { position: relative; height: 620px; overflow: hidden; }
  .manuscript-mock {
    position: absolute; inset: 0; padding: 40px 0;
    font-family: "Noto Sans SC", serif; color: var(--ink);
  }
  .editor-host {
    width: min(30em, calc(100% - 120px)); margin: 0 auto; padding: 44px 48px;
    background: var(--sheet); border: 1px solid var(--rule); border-radius: 2px;
    font-size: 17px; line-height: 1.95;
  }
  .editor-host p { margin: 0 0 0.9em; text-indent: 2em; }
  .panel-layer {
    padding: 22px 20px; color: var(--ink);
    font-family: "Jost", sans-serif; font-size: 13px;
  }
  .panel-layer h2 { margin: 0 0 14px; font-size: 15px; font-weight: 400; letter-spacing: 0.12em; }
  .panel-layer .field { padding: 9px 0; border-bottom: 1px solid var(--rule); color: var(--ink-soft); }
</style>
</head>
<body>
<div class="stage-row" data-panels="open" style="--panel-reserve:400px">
  <div class="lamp-layer" aria-hidden="true"></div>
  <div class="manuscript-mock">
    <article class="editor-host">
      <p>写作是把尚未成形的东西按住，让它在纸面上停留得够久，久到可以被看清。</p>
      <p>推敲の余地は、書いた本人にしか見えない。The quick brown fox jumps over the lazy dog.</p>
      <p>所以工具能做的只有一件事：不要在他按住那个东西的时候，把他的注意力拿走。</p>
    </article>
  </div>
  <section class="panel-layer" style="--panel-offset:0px">
    <h2>字体</h2>
    <div class="field">拉丁　Jost</div>
    <div class="field">中文　Noto Sans SC</div>
    <div class="field">日文　Zen Kaku Gothic New</div>
    <div class="field">字重　400</div>
    <div class="field">字距　0.01em</div>
  </section>
</div>
</body>
</html>`;
};

await mkdir(OUT, { recursive: true });

const root = "apps/desktop/src";
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const files: Record<string, string> = {
      "/fonts.css": `${root}/fonts.css`,
      "/themes.css": `${root}/themes.css`,
      "/app.css": `${root}/app.css`,
      "/surfaces.css": `${root}/styles/surfaces.css`,
    };
    const file = files[path];
    if (file !== undefined) {
      return new Response(await Bun.file(file).text(), { headers: { "content-type": "text/css" } });
    }
    if (path.startsWith("/fonts/")) return new Response(Bun.file(`${root}${path}`));
    const [, theme, material, lamp] = path.split("/");
    return new Response(
      page(theme ?? "tou", (material ?? "solid") as keyof typeof SPEC, lamp ?? "off"),
      { headers: { "content-type": "text/html" } },
    );
  },
});

const browser = await chromium.launch({ headless: true });
const view = await browser.newPage({ viewport: { width: 1180, height: 620 } });
const shots: string[] = [];
for (const theme of THEMES) {
  for (const material of MATERIALS) {
    for (const lamp of theme === "sumi" ? LAMPS : (["off"] as const)) {
      const name = `${theme}-${material}${lamp === "off" ? "" : `-${lamp}`}`;
      await view.goto(`http://127.0.0.1:${server.port}/${theme}/${material}/${lamp}`);
      // 动画跑完再截，否则拍到的是入场中途。
      await view.waitForTimeout(500);
      await view.screenshot({ path: `${OUT}/${name}.png` });
      if (process.env.LAMP_DIFF === "1") {
        const seen = await view.evaluate(() => {
          const host = document.querySelector(".editor-host");
          const panel = document.querySelector(".panel-layer");
          if (!(host instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;
          const hs = getComputedStyle(host);
          return {
            shadow: hs.boxShadow.slice(0, 100),
            bg: hs.backgroundImage.slice(0, 100),
            panelBg: getComputedStyle(panel).backgroundImage.slice(0, 70),
          };
        });
        console.log(name, JSON.stringify(seen));
      }
      shots.push(name);
    }
  }
}
await browser.close();
server.stop();
console.log(`wrote ${shots.length} shots to ${OUT}: ${shots.join(", ")}`);
