import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.addInitScript(`
  localStorage.clear();
  const chapter = { id: "01.md", title: "01", text: "盘上的正文。", root: "/work", path: "/work/01.md" };
  window.refrain = {
    openProject: async () => "/work",
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [chapter],
    loadWorkspace: async () => [chapter],
    saveChapter: async () => { throw new Error("simulated disk failure"); },
    resolveConflict: async () => ({ ok: false, reason: "not expected" }),
    pathFor: () => "",
    resolveDrop: async () => null,
    fullscreen: async () => true,
    systemFonts: async () => [],
    openProjectUrl: async () => true,
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
    searchLedger: async () => [],
    editsBetween: async () => [],
    revertEdit: async (text) => text,
    revertAll: async (text) => text,
    describeEdits: async () => "",
    files: {
      scan: async () => ({ ok: true, count: 0 }),
      page: async () => ({ ok: true, entries: [], total: 0 }),
      search: async () => ({ ok: true, hits: [] }),
      sort: async () => ({ ok: true }),
      trash: async () => ({ ok: true, outcomes: [] }),
      trashViaHome: async () => ({ ok: true, path: "" }),
    },
  };
`);

try {
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector<HTMLElement>(".actions .primary")?.click());
  await page.waitForTimeout(300);

  const manuscript = page.locator(".manuscript");
  await manuscript.locator("p").click();
  await page.keyboard.press("End");
  await page.keyboard.type("窗口里不能丢的字。");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(200);

  const text = (await manuscript.innerText()).replace(/\s+/g, "");
  if (!text.includes("窗口里不能丢的字")) throw new Error(`save failure lost editor text: ${text}`);
  if (!(await page.locator(".state").evaluate((node) => node.classList.contains("dirty"))))
    throw new Error("save failure marked the manuscript as saved");
  const notice = await page.locator(".notice").innerText();
  if (!notice.includes("simulated disk failure"))
    throw new Error(`save failure did not reach the interface: ${notice}`);
  if (pageErrors.length > 0) throw new Error(`unhandled page errors: ${pageErrors.join(" | ")}`);

  console.log("PASS  a failed save stays visible, unsaved, and recoverable in the editor");
} finally {
  await browser.close();
  server.stop();
}
