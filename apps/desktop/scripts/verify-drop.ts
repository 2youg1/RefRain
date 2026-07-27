/**
 * A dropped path enters the real renderer adoption chain.
 *
 * Playwright cannot manufacture Electron's `webUtils.getPathForFile`; that
 * one conversion remains a true Electron boundary. This gate starts at the
 * browser File it receives, verifies the public `pathFor` and `resolveDrop`
 * calls, then requires the dropped Root and chapter to appear. A stub that
 * returns the old `null` shape, or a renderer that swallows it, fails visibly.
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
window.__dropCalls = [];
${BRIDGE_STUB}
Object.assign(window.refrain, {
  pathFor: (file) => {
    window.__dropCalls.push(["pathFor", file.name]);
    return "/dropped";
  },
  resolveDrop: async (path) => {
    window.__dropCalls.push(["resolveDrop", path]);
    return { ok: true, path };
  },
  loadWorkspace: async (roots) => {
    window.__dropCalls.push(["loadWorkspace", ...roots]);
    return {
      roots: roots.map((path) => ({ id: "r-drop", path, name: "dropped", kind: "folder" })),
      chapters: [{ id: "01.md", title: "落下来的第一章", text: "正文。", rootId: "r-drop",
        root: roots[0], role: "chapter", path: roots[0] + "/01.md" }],
    };
  },
});`;

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(500);

await page.evaluate(() => {
  const transfer = new DataTransfer();
  transfer.items.add(new File(["drop"], "project-folder"));
  window.dispatchEvent(
    new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
  );
});
await page.waitForTimeout(800);

const observed = await page.evaluate(() => ({
  calls: (window as unknown as { __dropCalls: string[][] }).__dropCalls,
  stored: JSON.parse(localStorage.getItem("refrain.roots") ?? "[]") as string[],
  body: document.body.textContent ?? "",
}));

if (
  JSON.stringify(observed.calls) !==
  JSON.stringify([
    ["pathFor", "project-folder"],
    ["resolveDrop", "/dropped"],
    ["loadWorkspace", "/dropped"],
  ])
)
  failures.push(`drop calls were ${JSON.stringify(observed.calls)}`);
if (!observed.stored.includes("/dropped"))
  failures.push(`the dropped Root was not persisted: ${JSON.stringify(observed.stored)}`);
if (!observed.body.includes("落下来的第一章"))
  failures.push("the dropped project never reached the rail");
if (!observed.body.includes("正文。"))
  failures.push("the dropped chapter never reached the editor");

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error("FAIL the renderer did not adopt a dropped path");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS a dropped path reaches Root adoption and opens its chapter");
