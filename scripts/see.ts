#!/usr/bin/env bun
/*
 * 让 agent 看见自己做的前端。
 *
 * 这不是测试，是**视觉回执**：把真实运行的应用截成图，agent 读图，
 * 在提交之前就知道自己做出了什么。v0.2.1 的教训是盲着做会做出灾难级前端。
 *
 * 走的是真代码路径——Vite dev server 上的真实应用，不是手写的预览夹具。
 * 一张不走真代码路径的预览图，证明不了任何关于产品的事
 * （这条是 render-panel-preview.ts 的注释，同样适用于这里）。
 *
 * 用法：
 *   bun run scripts/see.ts                 # 默认视口
 *   bun run scripts/see.ts --w 1440 --h 900
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const REVIEW_DIR = process.env.REFRAIN_REVIEW_DIR ?? join(import.meta.dir, "..", "..", "review");
const OUT = join(REVIEW_DIR, "see");
const URL_ = process.env.REFRAIN_DEV_URL ?? "http://localhost:5173/";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const width = arg("w", 1280);
const height = arg("h", 860);

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });

/* 控制台错误是「界面为什么是坏的」最直接的证据，先接上再导航。 */
const problems: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console.error: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));

await page.goto(URL_, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  await document.fonts.ready;
});
await page.waitForTimeout(400);

/* 字体是否真的加载——CJK 用 canvas 指纹，不用 advance width（全角会误判）。 */
const fonts = await page.evaluate(() => {
  const list = Array.from(document.fonts).map((f) => `${f.family}:${f.status}`);
  const print = (family: string) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#000";
    ctx.font = "48px var(--font-cjk, serif)";
    ctx.textBaseline = "top";
    ctx.fillText("稿", 4, 4);
    return c.toDataURL().slice(-64);
  };
  return { faces: list, cjkDiffersFromMono: print("cjk") !== print("monospace") };
});

/* 布局体检：找出重叠、溢出、被切掉的元素——这些是「看着不对」的常见来源。 */
const layout = await page.evaluate((vw) => {
  const bad: { sel: string; why: string; rect: number[] }[] = [];
  const named = document.querySelectorAll<HTMLElement>("[class]");
  const seen = new Set<string>();
  for (const el of Array.from(named).slice(0, 400)) {
    const cls = el.className.toString().split(/\s+/)[0];
    if (!cls || seen.has(cls)) continue;
    seen.add(cls);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    if (r.right > vw + 1) bad.push({ sel: cls, why: `右溢出 ${Math.round(r.right - vw)}px`, rect });
    if (r.left < -1) bad.push({ sel: cls, why: `左溢出 ${Math.round(-r.left)}px`, rect });
    const s = getComputedStyle(el);
    if (s.overflow === "hidden" && el.scrollWidth > el.clientWidth + 2)
      bad.push({ sel: cls, why: `内容被切 ${el.scrollWidth - el.clientWidth}px`, rect });
  }
  return bad.slice(0, 20);
}, width);

const shot = join(OUT, "app.png");
await page.screenshot({ path: shot, fullPage: false });

console.log(
  JSON.stringify({ url: URL_, viewport: [width, height], fonts, layout, problems }, null, 1),
);
console.log(`\nSCREENSHOT ${shot}`);

await browser.close();
