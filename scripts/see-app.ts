#!/usr/bin/env bun
/**
 * 视觉回执：把真前端截下来，并量出盒子。
 *
 * 这不是门禁——门禁断言，这个只呈现。它存在的理由是 v0.2.1 的教训：
 * 盲着改前端会做出灾难级前端，而源码读起来永远是对的。
 *
 * 用法：
 *   bun scripts/see-app.ts                    # 默认三个场景
 *   bun scripts/see-app.ts --scene kara
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { stubScript } from "./stub-backend.ts";

const REVIEW_DIR = process.env.REFRAIN_REVIEW_DIR ?? join(import.meta.dir, "..", "..", "review");
const OUT = join(REVIEW_DIR, "see");
const URL_ = process.env.REFRAIN_DEV_URL ?? "http://127.0.0.1:5173/";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : (process.argv[i + 1] ?? fallback);
};
const num = (name: string, fallback: number): number => {
  const v = Number(arg(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};

const width = num("w", 1440);
const height = num("h", 900);
const only = arg("scene", "");

interface Scene {
  readonly name: string;
  readonly kara?: boolean;
  /** 进入工作台后要做的事：开面板、选字、右键。 */
  readonly act?: (page: Page) => Promise<void>;
}

/** 选中第二段的一小截，再在选区上右键——图二那张菜单就是这样出来的。 */
const selectAndContext = async (page: Page): Promise<void> => {
  const picked = await page.evaluate(() => {
    const blocks = document.querySelectorAll<HTMLElement>("[data-block-id]");
    if (blocks.length === 0)
      return {
        ok: false,
        why: `no [data-block-id]; editor html=${document.querySelector(".editor-host")?.innerHTML.slice(0, 300) ?? "(no .editor-host)"}`,
      };
    const target = blocks[1] ?? blocks[0];
    if (target === undefined) return { ok: false, why: "block list went empty" };
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (node === null) return { ok: false, why: "block has no text node" };
    const len = node.textContent?.length ?? 0;
    const range = document.createRange();
    range.setStart(node, Math.min(4, len));
    range.setEnd(node, Math.min(12, len));
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return { ok: true, why: "" };
  });
  if (!picked.ok) {
    console.log(`  [selection skipped] ${picked.why}`);
    return;
  }
  await page.waitForTimeout(120);
  const rect = await page.evaluate(() => {
    const selection = getSelection();
    if (selection === null || selection.rangeCount === 0) return null;
    const r = selection.getRangeAt(0).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (rect) await page.mouse.click(rect.x, rect.y, { button: "right" });
  await page.waitForTimeout(250);
};

const SCENES: readonly Scene[] = [
  { name: "workbench" },
  {
    name: "composer",
    act: async (page) => {
      await selectAndContext(page);
      const dispatch = page.locator("text=攒进发送").first();
      if (await dispatch.count()) await dispatch.click();
      await page.waitForTimeout(300);
      /* 「攒进发送」只把段落记进发送，发送台要从侧栏那一格进。 */
      const stage = page.locator(".rail-foot button", { hasText: "发送" }).first();
      if (await stage.count()) await stage.click();
      await page.waitForTimeout(700);
      if ((await page.locator(".dispatch").count()) === 0)
        console.log("  [composer] dispatch surface did not open");
    },
  },
  { name: "rail-and-menu", act: selectAndContext },
  { name: "kara", kara: true },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const findings: unknown[] = [];

for (const scene of SCENES) {
  if (only !== "" && scene.name !== only) continue;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await context.addInitScript(stubScript({ kara: scene.kara === true }));
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));

  await page.goto(URL_, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  /* 欢迎屏 → 工作台：走真按钮，stub 在 IPC 那头回一个 Root。 */
  const open = page.locator("button.welcome-open");
  if (await open.count()) {
    await open.click();
    await page.waitForTimeout(900);
    /* 点了还留在欢迎页，说明 stub 的回答形状不对——把 notice 原文带出来。 */
    if (await page.locator("button.welcome-open").count()) {
      const texts = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".welcome *"))
          .map((n) => (n.textContent ?? "").trim())
          .filter((t) => t.length > 0 && t.length < 200),
      );
      problems.push(`still on welcome after click; visible=${JSON.stringify(texts)}`);
    }
  }
  /* 采纳 Root 只是打开项目；正文要再选一份稿子才挂载。 */
  const doc = page.locator(".shelf li button").first();
  if (await doc.count()) {
    await doc.click();
    await page.waitForTimeout(800);
  }
  if ((await page.locator("[data-block-id]").count()) === 0) {
    problems.push("no manuscript blocks mounted after selecting a document");
  }
  if (scene.act) await scene.act(page);
  await page.waitForTimeout(300);
  const measure = await page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        sel,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        flexGrow: cs.flexGrow,
        zIndex: cs.zIndex,
        position: cs.position,
        opacity: cs.opacity,
        backdrop: cs.backdropFilter,
        background: cs.backgroundColor,
      };
    };
    const sels = [
      ".rail",
      ".rail .brand",
      ".logo-mark",
      ".rail-actions",
      ".rail-search",
      ".shelf",
      "main",
      ".stage-row",
      ".editor-host",
      ".dispatch",
      ".context-menu",
      ".kara-veil",
      ".kara-chrome",
      ".chrome",
      ".status-line",
    ];
    /* 溢出与被切：「看着不对」最常见的两个来源。 */
    const clipped: { sel: string; why: string }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[class]")).slice(0, 500)) {
      const cls = el.className.toString().split(/\s+/)[0];
      if (!cls) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1)
        clipped.push({ sel: cls, why: `右溢出 ${Math.round(r.right - innerWidth)}px` });
      if (r.bottom > innerHeight + 1)
        clipped.push({ sel: cls, why: `下溢出 ${Math.round(r.bottom - innerHeight)}px` });
    }
    return { boxes: sels.map(box).filter(Boolean), clipped: clipped.slice(0, 12) };
  });

  const shot = join(OUT, `${scene.name}.png`);
  await page.screenshot({ path: shot, fullPage: false });
  findings.push({ scene: scene.name, shot, ...measure, problems });
  console.log(`\n=== ${scene.name} → ${shot}`);
  console.log(JSON.stringify(measure, null, 1));
  if (problems.length) console.log("PROBLEMS:\n" + problems.join("\n"));
  await context.close();
}

await writeFile(join(OUT, "findings.json"), JSON.stringify(findings, null, 2));
await browser.close();
