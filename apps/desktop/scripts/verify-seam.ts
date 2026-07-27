/**
 * Is the seam still drawn after the rail became its own component?
 *
 * Vision reported it missing; the stylesheet says otherwise. Computed style is
 * the arbiter — a scoped-CSS regression would leave the property empty, and a
 * present-but-invisible shadow is a different problem from a lost one.
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

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(`
  ${BRIDGE_STUB}
  Object.assign(window.refrain, {
    openProject: async () => "/p", openFile: async () => null, createProject: async () => null,
    pathFor: () => "/p", resolveDrop: async (p) => p, fullscreen: async () => true, onCloseRequest: () => () => {},
    loadProject: async () => [], loadWorkspace: async () => ({ roots: [], chapters: [] }),
    saveChapter: async () => ({ ok: true, edits: [] }), systemFonts: async () => [], listAgents: async () => [],
    probeAgent: async () => ({ ok: true }), removeAgent: async () => true, addAgent: async () => ({}),
    enqueue: async () => true, manifest: async () => [], send: async () => [],
    collect: async () => ({ proposals: [], comments: [] }), runs: async () => [],
    commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
    revertEdit: async (t) => t, revertAll: async (t) => t,
    describeEdits: async () => "",
  });
  localStorage.setItem("refrain.roots", JSON.stringify(["/p"]));
`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(900);

const report = await page.evaluate(() => {
  const rail = document.querySelector(".rail");
  if (!rail) return { error: "no .rail — the component did not render" };
  const s = getComputedStyle(rail);
  const box = rail.getBoundingClientRect();
  return {
    boxShadow: s.boxShadow,
    background: s.backgroundColor,
    zIndex: s.zIndex,
    position: s.position,
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
});

console.log(JSON.stringify(report, null, 2));

if ("error" in report) {
  console.error("FAIL", report.error);
  process.exit(1);
}
// Colours resolve as oklch(), not rgb() — an earlier assertion looked for the
// wrong notation and reported a present shadow as missing.
const hasSeam = report.boxShadow !== "none" && report.boxShadow.split(",").length >= 3;
console.log(hasSeam ? "PASS  the seam is drawn" : "FAIL  box-shadow was lost in the split");

await browser.close();
server.stop();
process.exit(hasSeam ? 0 : 1);
