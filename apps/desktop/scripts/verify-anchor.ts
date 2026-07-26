/**
 * Prove the header and the manuscript share one left edge, by measurement.
 *
 * Vision reads "roughly aligned" as aligned; the header sat 57px right of the
 * body it names for two rounds because both were centred against boxes of
 * different widths. Geometry does not have that problem.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    return new Response(Bun.file(join(root, "dist", "renderer", p === "/" ? "index.html" : p)), {
      headers: { "cache-control": "no-store" },
    });
  },
});

const CHAPTERS = [
  { title: "01-夜行", root: "/p", path: "/p/01.md", text: "黑暗中有人问。\n\n声音很熟。" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(`
  window.refrain = {
    openProject: async () => "/p",
    openFile: async () => null,
    createProject: async () => null,
    pathFor: () => "/p",
    resolveDrop: async (p) => p,
    fullscreen: async () => true,
    loadProject: async () => ${JSON.stringify(CHAPTERS)},
    loadWorkspace: async () => ${JSON.stringify(CHAPTERS)},
    saveChapter: async () => true,
    systemFonts: async () => [],
    listAgents: async () => [],
    probeAgent: async () => ({ ok: true }),
    removeAgent: async () => true,
    addAgent: async () => ({}),
    enqueue: async () => true,
    manifest: async () => [],
    send: async () => [],
    collect: async () => ({ proposals: [], comments: [] }),
    runs: async () => [],
    commit: async () => ({ ok: true, text: "" }),
    ledger: async () => [],
    reply: async () => "",
    editsBetween: async () => [],
    revertEdit: async (t) => t,
    revertAll: async (t) => t,
    describeEdits: async () => "",
  };
  localStorage.setItem("refrain.roots", JSON.stringify(["/p"]));
`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(900);

// The header exists only with a chapter open — which is the state it has to
// align in. Measuring the empty screen measures nothing.
const chapterCount = await page.locator("nav .chapter").count();
console.log(`fixture: ${chapterCount} chapter(s) in the rail`);
if (chapterCount === 0) {
  const debug = await page.evaluate(() => ({
    welcome: document.querySelector(".welcome") !== null,
    roots: localStorage.getItem("refrain.roots"),
    railHtml: document.querySelector("nav.rail")?.innerHTML.slice(0, 200) ?? "(no rail)",
  }));
  console.error("fixture did not open a project:", JSON.stringify(debug, null, 2));
}
await page
  .locator("nav .chapter")
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(700);

const report = await page.evaluate(() => {
  const box = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), width: Math.round(r.width) };
  };
  const rail = document.querySelector(".bar-rail");
  return {
    bar: box(".bar"),
    barRail: box(".bar-rail"),
    sheet: box(".sheet-surface"),
    measure: getComputedStyle(document.documentElement).getPropertyValue("--manuscript-measure"),
    railWidth: rail ? getComputedStyle(rail).width : "(no .bar-rail)",
  };
});

console.log(JSON.stringify(report, null, 2));

if (!report.bar || !report.sheet) {
  console.error("\nSKIP  no chapter open in the fixture; nothing to compare");
  await browser.close();
  server.stop();
  process.exit(0);
}

const drift = Math.abs(report.bar.left - report.sheet.left);
console.log("\n--- verdict ---");
console.log(`bar   left ${report.bar.left}  width ${report.bar.width}`);
console.log(`sheet left ${report.sheet.left}  width ${report.sheet.width}`);
console.log(`drift ${drift}px`);
console.log(drift <= 1 ? "PASS  one left edge" : "FAIL  the column does not hang from one line");

await browser.close();
server.stop();
process.exit(drift <= 1 ? 0 : 1);
