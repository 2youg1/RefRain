/**
 * A failed save does not move the author off the text it failed to write.
 *
 * Switching chapters saves first — the comment above `select()` says the
 * manuscript is the one thing this application may never lose. But it switched
 * on `save().then(...)`, and every failure inside `save()` resolves normally:
 * a conflict returns, an exception is caught and announced in a toast. So the
 * `.then` ran unconditionally, `selectNow` replaced `text` with the newly
 * chosen chapter, and the unsaved characters — held nowhere else — were gone.
 * The repair introduced the loss it was written to prevent.
 *
 * This drives the real build with a bridge whose `saveChapter` refuses, types
 * into the manuscript, clicks another chapter, and asserts the editor is still
 * showing the text that was never written.
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

/** Saving throws, the way a read-only volume or a full disk makes it throw. */
const bridge = `
localStorage.setItem("refrain.roots", JSON.stringify(["/work"]));
${BRIDGE_STUB}
Object.assign(window.refrain, {
  openProject: async () => "/work",
  openFile: async () => null,
  createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  loadProject: async () => [],
  saveChapter: async () => { throw new Error("磁盘拒绝了这次写入"); },
  loadWorkspace: async (roots) => {
    const p = roots[0]; const id = "r-work";
    const of = (n, title, body) => ({ id: n, title, text: body, rootId: id, root: p,
      role: "chapter", path: p + "/" + n });
    return { roots: [{ id, path: p, name: "work", kind: "folder" }],
      chapters: [of("01.md", "第一章", "第一章的原文。"), of("02.md", "第二章", "第二章的原文。")] };
  },
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {}, fonts: async () => [],
});`;

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(900);

const PRECIOUS = "这段字还没有写到盘上。";

// Type into the first chapter, so there is unsaved text worth protecting.
await page.click(".manuscript p");
await page.keyboard.press("End");
await page.keyboard.type(PRECIOUS);
await page.waitForTimeout(300);

// Ask for the second chapter. The save on the way out is going to throw.
await page.evaluate(() => {
  [...document.querySelectorAll<HTMLElement>(".rail .chapter")]
    .find((n) => /第二章/.test(n.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(900);

const after = await page.evaluate(() => ({
  manuscript: document.querySelector(".manuscript")?.textContent ?? "",
  selected: document.querySelector(".rail .chapter.on")?.textContent?.trim() ?? "",
  notice: document.querySelector(".notice")?.textContent?.trim() ?? "",
}));

if (!after.manuscript.includes(PRECIOUS))
  failures.push(`the unsaved text is gone from the editor: ${JSON.stringify(after.manuscript)}`);
if (after.manuscript.includes("第二章的原文"))
  failures.push("the editor moved to the other chapter even though the save failed");
if (after.notice === "") failures.push("the failure was never announced");

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error("FAIL a failed save still let the chapter switch happen");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS a failed save keeps the author on the text it could not write");
