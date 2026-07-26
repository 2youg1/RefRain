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
await page.addInitScript(`
  localStorage.clear();
  window.__calls = [];
  window.__openCount = 0;
  const roots = [
    { id: "r-a", path: "/a", name: "a", kind: "folder" },
    { id: "r-b", path: "/b", name: "b", kind: "folder" },
  ];
  const chapters = [
    { id: "01.md", title: "01", text: "第一个根的正文。", root: "/a", rootId: "r-a",
      role: "chapter", path: "/a/01.md" },
    { id: "01.md", title: "01", text: "第二个根的正文。", root: "/b", rootId: "r-b",
      role: "chapter", path: "/b/01.md" },
  ];
  window.refrain = {
    openProject: async () => ["/a", "/b"][window.__openCount++] ?? null,
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [],
    loadWorkspace: async (open) => ({
      roots: roots.filter((root) => open.includes(root.path)),
      chapters: chapters.filter((chapter) => open.includes(chapter.root)),
    }),
    saveChapter: async (root, title, text) => {
      window.__calls.push(["save", root, title, text]);
      return { ok: true, edits: [] };
    },
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
  await page.locator(".rail-foot button").first().click();
  await page.waitForTimeout(300);

  const second = page.locator(".root").nth(1).locator(".chapter");
  await second.click();
  await page.waitForTimeout(100);
  const before = (await page.locator(".manuscript").innerText()).replace(/\s+/g, "");
  if (!before.includes("第二个根的正文"))
    throw new Error(`selecting /b/01.md showed the wrong chapter: ${before}`);

  await page.locator(".manuscript > p").click();
  await page.keyboard.press("End");
  await page.keyboard.type("只写进第二个根。");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(300);

  const calls: [string, string, string, string][] = await page.evaluate(() =>
    JSON.parse(JSON.stringify((window as unknown as { __calls: unknown[] }).__calls)),
  );
  const last = calls.at(-1);
  if (last?.[1] !== "/b" || last[2] !== "01.md" || !last[3]?.includes("第二个根"))
    throw new Error(`saving /b/01.md targeted the wrong chapter: ${JSON.stringify(calls)}`);

  console.log("PASS  duplicate chapter titles stay isolated by file path across workspace roots");
} finally {
  await browser.close();
  server.stop();
}
