import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";

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

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.addInitScript(`
  localStorage.clear();
  window.__calls = [];
  const root = { id: "r-work", path: "/work", name: "work", kind: "folder" };
  const chapter = {
    id: "01.md", title: "01", root: "/work", rootId: "r-work", role: "chapter",
    path: "/work/01.md", text: "甲。\\n\\n乙。\\n\\n丙。",
  };
  const removed = {
    id: "e0-01.md:b1", kind: "remove", blockId: "01.md:b1",
    before: "乙。", nextBlockId: "01.md:b2", at: "2026-07-27T00:00:00.000Z",
  };
  window.refrain = {
    openProject: async () => "/work",
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [chapter],
    loadWorkspace: async () => ({ roots: [root], chapters: [chapter] }),
    saveChapter: async (root, chapterId, text) => {
      window.__calls.push(["save", root, chapterId, text]);
      return { ok: true, edits: [removed] };
    },
    resolveConflict: async () => ({ ok: false, reason: "not expected" }),
    revertEdit: async (root, chapterId, edit) => {
      window.__calls.push(["revert", root, chapterId, edit.id]);
      return "甲。\\n\\n乙。\\n\\n丙。";
    },
    revertAll: async () => "甲。\\n\\n乙。\\n\\n丙。",
    describeEdits: async () => "",
    pathFor: () => "",
    resolveDrop: async () => null,
    fullscreen: async () => true,
    onCloseRequest: () => () => {},
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
    searchLedger: async () => [],
    reply: async () => "",
    files: {
      scan: async () => ({ ok: true, count: 0 }),
      page: async () => ({ ok: true, entries: [], total: 0 }),
      search: async () => ({ ok: true, hits: [] }),
      searchDirectories: async () => ({ ok: true, hits: [] }),
      sort: async () => ({ ok: true }),
      move: async () => ({ ok: false, detail: "not expected" }),
      copy: async () => ({ ok: false, detail: "not expected" }),
      trash: async () => ({ ok: true, outcomes: [] }),
      trashViaHome: async () => ({ ok: false, detail: "not expected" }),
      link: async () => ({ ok: false, detail: "not expected" }),
      createDirectory: async () => ({ ok: false, detail: "not expected" }),
      uniqueName: async () => ({ ok: false, detail: "not expected" }),
      admits: async () => ({ ok: true, admitted: true }),
    },
  };
`);

try {
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector<HTMLElement>(".actions .primary")?.click());
  const manuscript = page.getByRole("textbox", { name: "manuscript" });
  await manuscript.waitFor();
  await manuscript.evaluate((element) => {
    element.innerHTML = "<p>甲。</p><p>丙。</p>";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
  });
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.__calls?.some((call) => call[0] === "save"));

  await page.keyboard.press("Control+k");
  await page.getByRole("button", { name: "修改记录" }).click();
  await page.getByRole("button", { name: "撤回", exact: true }).click();
  await page.waitForFunction(() => window.__calls?.some((call) => call[0] === "revert"));

  const text = await manuscript.innerText();
  const calls = await page.evaluate(() => window.__calls);
  await page.screenshot({ path: "/tmp/refrain-0.1.5-revert.png" });
  if (text.replace(/\n+/g, "\n\n").trim() !== "甲。\n\n乙。\n\n丙。")
    throw new Error(`wrong manuscript after revert: ${JSON.stringify(text)}`);
  if (!calls.some((call) => call.join("|") === "revert|/work|01.md|e0-01.md:b1"))
    throw new Error(`wrong revert call: ${JSON.stringify(calls)}`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join("; ")}`);
  console.log("PASS  a saved middle-paragraph removal reverts through the rendered interface");
} finally {
  await browser.close();
  server.stop(true);
}

declare global {
  interface Window {
    __calls?: unknown[][];
  }
}
