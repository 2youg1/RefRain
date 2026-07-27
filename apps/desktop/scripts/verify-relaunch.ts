/**
 * The workspace comes back when the application starts.
 *
 * `reload()` is the only function that calls `loadWorkspace(roots)`, and every
 * one of its call sites was a user action — the rail button, the palette, a
 * drop, a removal. Nothing called it on mount. Meanwhile `roots` is restored
 * from localStorage, so a second launch had roots but no chapters: the welcome
 * page was skipped because roots existed, and the rail was empty because
 * nothing had loaded them. The manuscript looked gone.
 *
 * The self-rescue was closed too. Re-opening the same folder hit `addRoot`'s
 * duplicate check, which returned without loading anything, so the one obvious
 * recovery did nothing either.
 *
 * This drives the real build with roots already in localStorage and asserts a
 * chapter is on screen, then re-adds the same root and asserts it reloads
 * rather than silently declining.
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

/**
 * Roots are seeded the way a previous session would have left them, and the
 * bridge counts loads so a re-add can be told from a silent refusal.
 */
const bridge = `
localStorage.setItem("refrain.roots", JSON.stringify(["/work"]));
window.__loads = 0;
window.__failLoad = false;
${BRIDGE_STUB}
Object.assign(window.refrain, {
  openProject: async () => "/work",
  openFile: async () => null,
  createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  loadProject: async () => [],
  saveChapter: async () => ({ ok: true, edits: [] }),
  loadWorkspace: async (roots) => {
    window.__loads += 1;
    if (window.__failLoad) throw new Error("EACCES: workspace cannot be read");
    const p = roots[0]; const id = "r-work";
    return { roots: [{ id, path: p, name: "work", kind: "folder" }],
      chapters: [{ id: "01.md", title: "第一章 序", text: "去年的稿子还在。", rootId: id,
        root: p, role: "chapter", path: p + "/01.md" }] };
  },
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {},
});`;

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(900);

// ── A second launch shows the work, without the author touching anything ──
const onStart = await page.evaluate(() => ({
  loads: (window as unknown as { __loads: number }).__loads,
  rail: [...document.querySelectorAll(".rail .chapter")].map((n) => n.textContent?.trim()),
  manuscript: document.querySelector(".manuscript")?.textContent?.trim() ?? "",
  welcome: !!document.querySelector(".welcome"),
}));

if (onStart.loads === 0) failures.push("the workspace was never loaded on start");
if (onStart.rail.length === 0)
  failures.push(`the rail is empty on a second launch: ${onStart.rail}`);
if (!onStart.manuscript.includes("去年的稿子"))
  failures.push(`the manuscript did not open: ${JSON.stringify(onStart.manuscript)}`);
if (onStart.welcome) failures.push("the welcome page showed even though roots were remembered");

// ── Re-opening the same folder reloads it, rather than declining in silence ──
const before = await page.evaluate(() => (window as unknown as { __loads: number }).__loads);
await page.evaluate(() => {
  [...document.querySelectorAll<HTMLElement>(".rail-foot button")]
    .find((b) => /打开文件夹|Open folder/.test(b.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(700);
const after = await page.evaluate(() => (window as unknown as { __loads: number }).__loads);
if (after <= before)
  failures.push("re-opening the same folder did nothing — the one self-rescue is closed");

// A later read failure keeps the loaded manuscript and says why refresh stopped.
await page.evaluate(() => {
  (window as unknown as { __failLoad: boolean }).__failLoad = true;
  [...document.querySelectorAll<HTMLElement>(".rail-foot button")]
    .find((button) => /打开文件夹|Open folder/.test(button.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(400);
const failedReload = await page.evaluate(() => ({
  body: document.body.textContent ?? "",
  manuscript: document.querySelector(".manuscript")?.textContent ?? "",
}));
if (!failedReload.body.includes("EACCES: workspace cannot be read"))
  failures.push("a rejected workspace reload said nothing on screen");
if (!failedReload.manuscript.includes("去年的稿子"))
  failures.push("a rejected workspace reload erased the loaded manuscript");

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error("FAIL the workspace does not come back on a second launch");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS a remembered workspace loads itself, and re-opening it reloads");
