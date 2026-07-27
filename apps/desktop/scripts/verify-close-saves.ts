/** A close may leave the editor only after its unsaved text reaches disk. */
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
    return path === "/"
      ? new Response(html, { headers: { "content-type": "text/html" } })
      : new Response(Bun.file(join(desktop, "dist", "renderer", path)));
  },
});

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(`${BRIDGE_STUB}
localStorage.setItem("refrain.roots", JSON.stringify(["/work"]));
window.__saveSucceeds = false;
window.__closeRequest = null;
const chapter = { id: "01.md", title: "第一章", text: "盘上的正文。", root: "/work",
  rootId: "r-work", role: "chapter", path: "/work/01.md" };
Object.assign(window.refrain, {
  loadWorkspace: async () => ({
    roots: [{ id: "r-work", path: "/work", name: "work", kind: "folder" }],
    chapters: [chapter],
  }),
  saveChapter: async () => {
    if (!window.__saveSucceeds) throw new Error("simulated close save failure");
    return { ok: true, edits: [] };
  },
  onCloseRequest: (listener) => { window.__closeRequest = listener; return () => {}; },
});`);

try {
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(500);
  await page.click(".manuscript p");
  await page.keyboard.press("End");
  await page.keyboard.type("不能丢的字。");

  const failed = await page.evaluate(async () => {
    const close = (window as unknown as { __closeRequest: () => Promise<boolean> }).__closeRequest;
    return close();
  });
  if (failed !== false)
    throw new Error("a failed save told main that the window was safe to close");
  const stillThere = await page.locator(".manuscript").innerText();
  if (!stillThere.includes("不能丢的字")) throw new Error("the failed close lost the editor text");

  const saved = await page.evaluate(async () => {
    const held = window as unknown as {
      __saveSucceeds: boolean;
      __closeRequest: () => Promise<boolean>;
    };
    held.__saveSucceeds = true;
    return held.__closeRequest();
  });
  if (saved !== true) throw new Error("a successful close-time save did not release the window");

  console.log("PASS a close is released only after the manuscript reaches disk");
} finally {
  await browser.close();
  server.stop(true);
}
