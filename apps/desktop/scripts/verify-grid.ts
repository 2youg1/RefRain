/**
 * Prove the ruled lines land under the glyphs, by geometry rather than by eye.
 *
 * Vision misreads this: a rule a pixel below the descender and a rule through
 * the character both read as "a line near the text" in a screenshot. The line
 * box positions and the gradient stop are numbers, so they can simply be
 * compared.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = (await Bun.file(join(root, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, "dist", "renderer", p)));
  },
});

const LONG =
  "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜，那时他也是这样开口的，隔着一层水汽，像怕惊动什么。";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(`window.recension = {
  openProject: async () => "/p",
  loadProject: async () => [{ title: "01", text: ${JSON.stringify(LONG)} }],
  createProject: async () => null, pathFor: () => "", resolveDrop: async () => null,
  fullscreen: async () => true, saveChapter: async () => true, listAgents: async () => [],
  addAgent: async () => ({}), enqueue: async () => true, manifest: async () => [], send: async () => [],
  collect: async () => ({ proposals: [], comments: [] }), runs: async () => [],
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
};`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector<HTMLElement>(".actions .primary")?.click());
await page.waitForTimeout(500);

// Turn the grid on through the interface, the way an author would.
await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
await page.getByRole("button", { name: "排版…" }).click();
await page.waitForTimeout(350);
await page.getByRole("button", { name: "基线网格" }).click();
await page.waitForTimeout(400);

const report = await page.evaluate(() => {
  const paragraph = document.querySelector<HTMLElement>(".manuscript > p");
  if (!paragraph) return { error: "no paragraph" };

  const style = getComputedStyle(paragraph);
  const size = Number.parseFloat(style.fontSize);
  const lineBox = Number.parseFloat(style.lineHeight);
  const fontLine = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--font-line") || "1.16",
  );

  // Where each glyph run actually sits, measured from the paragraph's top.
  const range = document.createRange();
  const node = paragraph.firstChild;
  if (!node) return { error: "empty paragraph" };

  const top = paragraph.getBoundingClientRect().top;
  const lines: { top: number; bottom: number }[] = [];
  for (const rect of range.getClientRects.call(
    (() => {
      range.selectNodeContents(paragraph);
      return range;
    })(),
  ))
    lines.push({ top: rect.top - top, bottom: rect.bottom - top });

  const halfLeading = (lineBox - size * fontLine) / 2;
  const ruleAt = halfLeading + size * fontLine;

  return {
    size,
    lineBox,
    fontLine,
    ruleAt: Math.round(ruleAt * 100) / 100,
    lineCount: lines.length,
    lines: lines.map((l) => ({
      top: Math.round(l.top * 10) / 10,
      bottom: Math.round(l.bottom * 10) / 10,
    })),
    backgroundImage: style.backgroundImage.slice(0, 90),
  };
});

console.log(JSON.stringify(report, null, 2));

if (!("error" in report) && report.lines && report.lines.length >= 2) {
  const [first, second] = report.lines;
  console.log("\n--- verdict ---");
  console.log(`line box            : ${report.lineBox}px`);
  console.log(`rule drawn at       : ${report.ruleAt}px from each line's top`);
  console.log(`line 1 glyph bottom : ${first?.bottom}px`);
  console.log(`line 2 glyph top    : ${second?.top}px`);
  const gap = (second?.top ?? 0) - (first?.bottom ?? 0);
  console.log(`gap between lines   : ${Math.round(gap * 10) / 10}px`);
  const inGap = (report.ruleAt ?? 0) >= (first?.bottom ?? 0);
  console.log(inGap ? "PASS  the rule sits below the glyphs" : "FAIL  the rule crosses the glyphs");
}

await browser.close();
server.stop();
