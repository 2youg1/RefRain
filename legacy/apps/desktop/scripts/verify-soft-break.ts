/**
 * Shift+Enter survives the renderer's real input and save path.
 *
 * The v0.1.6 audit predicted Chromium would store the break as `<br>` and that
 * `textContent` would erase it. The shipped engine currently inserts a newline
 * in a text node because the surface is `white-space: pre-wrap`; the alleged
 * loss is not reproducible. This gate keeps the behavioral contract rather
 * than the prediction: whichever DOM shape a future Chromium chooses, the
 * public save bridge must receive exactly one authored newline.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const html = (await Bun.file(join(desktop, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(desktop, "dist", "renderer", path)));
  },
});

const bridge = `
localStorage.setItem("refrain.roots", JSON.stringify(["/work"]));
window.__saved = [];
${BRIDGE_STUB}
Object.assign(window.refrain, {
  loadWorkspace: async () => ({
    roots: [{ id: "r-work", path: "/work", name: "work", kind: "folder" }],
    chapters: [{ id: "01.md", title: "第一章", text: "甲。", rootId: "r-work",
      root: "/work", role: "chapter", path: "/work/01.md" }],
  }),
  saveChapter: async (root, id, text) => {
    window.__saved.push({ root, id, text });
    return { ok: true, edits: [] };
  },
});`;

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(900);

const paragraph = page.locator(".manuscript > p").first();
await paragraph.click();
await page.keyboard.press("End");
await page.keyboard.down("Shift");
await page.keyboard.press("Enter");
await page.keyboard.up("Shift");
await page.keyboard.type("乙。");

const domShape = await paragraph.evaluate((node) => node.innerHTML);

await page.keyboard.press("Control+s");
await page.waitForTimeout(300);

const saved = await page.evaluate(
  () => (window as unknown as { __saved: { root: string; id: string; text: string }[] }).__saved,
);
if (saved.length !== 1) failures.push(`expected one save, observed ${saved.length}`);
if (saved[0]?.text !== "甲。\n乙。")
  failures.push(
    `Shift+Enter reached save as ${JSON.stringify(saved[0]?.text)} from ${JSON.stringify(domShape)}`,
  );

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error("FAIL Shift+Enter was not preserved by the real renderer save path");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS Shift+Enter reaches save as one authored newline");
