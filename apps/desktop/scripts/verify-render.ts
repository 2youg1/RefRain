/**
 * Measure what actually rendered. Vision misjudges CJK type and colour; DOM
 * geometry and computed styles do not.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";

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

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(`window.refrain = {
  openProject: async () => "/p", loadProject: async () => [{ id: "01.md", title: "01", text: "黑暗中有人问。\\n\\n声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜，那时他也是这样开口的。\\n\\n剑尖垂下去，抵住青石板。" }],
  createProject: async () => null, pathFor: () => "", resolveDrop: async () => null,
  fullscreen: async () => true, saveChapter: async () => ({ ok: true, edits: [] }), listAgents: async () => [],
  addAgent: async () => ({}), enqueue: async () => true, manifest: async () => [], send: async () => [],
  collect: async () => ({ proposals: [], comments: [] }), runs: async () => [],
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
};`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector<HTMLElement>(".actions .primary")?.click());
await page.waitForTimeout(600);

// A 15 MB CJK face reports `loaded` before it is usable; force the glyphs to
// be decoded and wait for the advance to settle.
await page.evaluate(async () => {
  await document.fonts.load('17px "Chiron Sung HK"', "夜行剑锋黑暗中有人问");
  await document.fonts.ready;
});
await page.waitForTimeout(2500);

const report = await page.evaluate(async () => {
  await document.fonts.ready;
  const loaded = Array.from(document.fonts).map((f) => `${f.family}:${f.status}`);

  /**
   * Both CJK faces are full-width, so advance width cannot distinguish them.
   * Render the same glyph to a canvas under each family and compare the pixels:
   * two different typefaces cannot produce an identical bitmap.
   */
  const fingerprint = (family: string): string => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#000";
    ctx.font = `48px ${family}`;
    ctx.textBaseline = "top";
    ctx.fillText("剑", 4, 4);
    return canvas.toDataURL().slice(-96);
  };

  const advance = (family: string): number => {
    const s = document.createElement("span");
    s.style.cssText = `position:absolute;visibility:hidden;font-size:100px;font-family:${family}`;
    s.textContent = "夜行剑锋";
    document.body.append(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return Math.round(w);
  };

  const manuscript = document.querySelector<HTMLElement>(".manuscript");
  const computed = manuscript ? getComputedStyle(manuscript) : null;

  return {
    faces: loaded,
    chironAdvance: advance('"Chiron Sung HK"'),
    fallbackAdvance: advance("monospace"),
    chironLoaded: fingerprint('"Chiron Sung HK"') !== fingerprint("monospace"),
    manuscriptFamily: computed?.fontFamily ?? "(none)",
    manuscriptSize: computed?.fontSize ?? "",
    lineHeight: computed?.lineHeight ?? "",
    fontLineVar: getComputedStyle(document.documentElement).getPropertyValue("--font-line"),
  };
});

console.log("faces        :", report.faces.join(", ") || "(none)");
console.log("chiron adv   :", report.chironAdvance, "| fallback:", report.fallbackAdvance);
console.log("chiron loaded:", report.chironLoaded ? "YES" : "NO  <-- CJK falls back");
console.log("manuscript   :", report.manuscriptFamily);
console.log("size/leading :", report.manuscriptSize, "/", report.lineHeight);
console.log("--font-line  :", report.fontLineVar || "(unset)");

await browser.close();
server.stop();
