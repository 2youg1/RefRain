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
  const root = { id: "r-work", path: "/work", name: "work", kind: "folder" };
  const chapter = { id: "01.md", title: "01", text: "等待 Agent 的正文。", root: "/work",
    rootId: "r-work", role: "chapter", path: "/work/01.md" };
  let queued = false;
  let sent = false;
  let reads = 0;
  window.refrain = {
    openProject: async () => "/work",
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [chapter],
    loadWorkspace: async () => ({ roots: [root], chapters: [chapter] }),
    saveChapter: async () => ({ ok: true, edits: [] }),
    resolveConflict: async () => ({ ok: false, reason: "not expected" }),
    pathFor: () => "",
    resolveDrop: async () => null,
    fullscreen: async () => true,
    onCloseRequest: () => () => {},
    systemFonts: async () => [],
    openProjectUrl: async () => true,
    listAgents: async () => [{
      id: "a1", name: "slow", binding: { harness: "command:a1", model: "unknown", reasoningEffort: "unknown" },
    }],
    probeAgent: async () => ({ ok: true }),
    removeAgent: async () => true,
    addAgent: async () => ({}),
    enqueue: async () => { queued = true; return true; },
    manifest: async () => queued ? [{
      agentName: "slow", harness: "command:a1", model: "unknown", reasoningEffort: "unknown",
      runCount: 1, scopes: ["s1"], prompts: ["改写"], drifted: [],
    }] : [],
    send: async () => { sent = true; return [{ id: "run1", requestPath: "/request", resultPath: "/result" }]; },
    collect: async () => ({ proposals: [], comments: [] }),
    runs: async () => {
      if (!sent) return [];
      reads += 1;
      return reads < 3
        ? [{ id: "run1", state: "dispatched", resultPath: "/result", agentId: "a1" }]
        : [{ id: "run1", state: "failed", resultPath: "/result", agentId: "a1",
             failure: "slow exited 7 after writing no result" }];
    },
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
  await page.evaluate(() => {
    const paragraph = document.querySelector(".manuscript p");
    if (!paragraph) throw new Error("no manuscript paragraph");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.keyboard.press("Control+d");
  await page.locator(".dispatch textarea").fill("改写这一段。");
  await page.locator(".dispatch .queue").click();
  await page.locator(".dispatch .send").click();

  await page.locator(".run-state.failed").waitFor({ timeout: 2500 });
  const failure = await page.locator(".run-failure").innerText();
  if (!failure.includes("exited 7 after writing no result"))
    throw new Error(`failure reason did not refresh: ${failure}`);
  if ((await page.locator(".run button").count()) !== 0)
    throw new Error("a failed run still offers Collect");
  if (pageErrors.length > 0) throw new Error(`unhandled page errors: ${pageErrors.join(" | ")}`);

  console.log("PASS  a slow run failure refreshes itself and explains why without another click");
} finally {
  await browser.close();
  server.stop();
}
