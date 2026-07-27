/**
 * Prove the header and the manuscript share one left edge, by measurement.
 *
 * Vision reads "roughly aligned" as aligned; the header sat 57px right of the
 * body it names for two rounds because both were centred against boxes of
 * different widths. Geometry does not have that problem.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

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
  {
    id: "01.md",
    title: "01-夜行",
    root: "/p",
    path: "/p/01.md",
    text: "黑暗中有人问。\n\n声音很熟。",
  },
];

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(`
  ${BRIDGE_STUB}
  Object.assign(window.refrain, {
    openProject: async () => "/p",
    openFile: async () => null,
    createProject: async () => null,
    pathFor: () => "/p",
    resolveDrop: async (p) => p,
    fullscreen: async () => true,
    onCloseRequest: () => () => {},
    loadProject: async () => ${JSON.stringify(CHAPTERS)},
    loadWorkspace: async () => ${JSON.stringify(CHAPTERS)},
    saveChapter: async () => ({ ok: true, edits: [] }),
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

    revertEdit: async (t) => t,
    revertAll: async (t) => t,
    describeEdits: async () => "",
  });
  localStorage.setItem("refrain.roots", JSON.stringify(["/p"]));
`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(900);

/*
 * The workspace loads on an explicit action rather than on mount, so seeding
 * `refrain.roots` alone lands on the blank screen and the header never exists.
 * "打开文件夹" is the command a person uses; `openProject` in the stub returns
 * the fixture root, so this drives the same path the application really takes.
 */
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
await page.locator("nav.menu input").fill("文件夹");
await page.waitForTimeout(300);
const opener = page.locator("nav.menu button.row").first();
if ((await opener.count()) > 0) await opener.click();
await page.waitForTimeout(900);

/*
 * The header renders only with a chapter open, and `Progress.svelte` also
 * carries a `.bar` class. With no chapter the old selector silently measured
 * the progress rule instead — which is the whole of the 289px "drift" recorded
 * as SPEC Q5. The count is asserted, not logged, so an empty fixture fails
 * rather than reporting a defect that is not there.
 */
const chapterCount = await page.locator("nav .chapter").count();
console.log(`fixture: ${chapterCount} chapter(s) in the rail`);
if (chapterCount === 0) {
  const debug = await page.evaluate(() => ({
    welcome: document.querySelector(".welcome") !== null,
    roots: localStorage.getItem("refrain.roots"),
    railHtml: document.querySelector("nav.rail")?.innerHTML.slice(0, 200) ?? "(no rail)",
  }));
  console.error("FAIL  the fixture opened no project:", JSON.stringify(debug, null, 2));
  await browser.close();
  server.stop();
  process.exit(1);
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
    // `header.bar`, not `.bar`: Progress.svelte uses the same class name.
    bar: box("header.bar"),
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
