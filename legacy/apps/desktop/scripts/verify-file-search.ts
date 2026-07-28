/**
 * F-14's real-renderer gate.
 *
 * The fake native API keeps search promises pending until the gate chooses their
 * completion order. That makes both the input boundary and the async commit
 * boundary observable in Chromium rather than inferred from source.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

declare global {
  interface Window {
    __fileSearchCalls: { root: string; query: string }[];
    __resolveFileSearch(query: string): void;
    __clearFileSearchCalls(): void;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const workspace = "/home/author/novel";
const baseEntry = {
  path: `${workspace}/base-a.md`,
  name: "base-a.md",
  kind: "file",
  size: 12,
  modifiedMs: 1_700_000_000_000,
  depth: 1,
  manuscript: true,
};

const bridge = `
  ${BRIDGE_STUB}
  const baseEntry = ${JSON.stringify(baseEntry)};
  const pendingSearches = new Map();
  window.__fileSearchCalls = [];
  window.__clearFileSearchCalls = () => { window.__fileSearchCalls = []; };
  window.__resolveFileSearch = (query) => {
    const pending = pendingSearches.get(query);
    if (!pending) throw new Error("no pending search for " + query);
    pendingSearches.delete(query);
    pending.resolve({
      ok: true,
      hits: [{
        entry: { ...baseEntry, path: ${JSON.stringify(workspace)} + "/" + query + ".md", name: query + ".md" },
        score: 1,
        positions: [],
      }],
    });
  };
  Object.assign(window.refrain, {
    openProject: async () => null,
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [],
    loadWorkspace: async () => ({
      roots: [{ id: "root-a", path: ${JSON.stringify(workspace)}, name: "novel", kind: "folder" }],
      chapters: [{
        id: "base-a.md",
        title: "base-a",
        text: "base",
        rootId: "root-a",
        root: ${JSON.stringify(workspace)},
        role: "chapter",
        path: ${JSON.stringify(`${workspace}/base-a.md`)},
      }],
    }),
    saveChapter: async () => ({ ok: true, edits: [] }),
    systemFonts: async () => [],
    pathFor: () => "",
    resolveDrop: async () => ({ ok: false, reason: "unused", detail: "unused" }),
    fullscreen: async () => false,
    listAgents: async () => [],
    probeAgent: async () => ({ ok: true }),
    trustAgent: async () => true,
    removeAgent: async () => true,
    addAgent: async () => ({}),
    enqueue: async () => true,
    manifest: async () => [],
    send: async () => [],
    cancel: async () => true,
    collect: async () => ({ proposals: [], comments: [] }),
    runs: async () => [],
    commit: async () => ({ ok: true, text: "" }),
    ledger: async () => ({ ok: true, verdicts: [] }),
    searchLedger: async () => ({ ok: true, verdicts: [] }),
    reply: async () => "",
    note: async () => ({ ok: false, reason: "unused", detail: "unused" }),
    notes: async () => ({ ok: true, notes: [] }),
    dropNote: async () => ({ ok: true }),
    revertEdit: async () => "",
    revertAll: async () => "",
    describeEdits: async () => "",
    files: {
      ...window.refrain.files,
      onChange: () => () => {},
      scan: async () => ({ ok: true, count: 1 }),
      page: async () => ({ ok: true, entries: [baseEntry], total: 1 }),
      search: async (root, query) => {
        window.__fileSearchCalls.push({ root, query });
        return await new Promise((resolve) => pendingSearches.set(query, { resolve }));
      },
      searchDirectories: async () => ({ ok: true, hits: [] }),
      sort: async () => ({ ok: true }),
      move: async () => ({ ok: true, path: "" }),
      copy: async () => ({ ok: true, path: "" }),
      trash: async () => ({ ok: true, outcomes: [] }),
      trashViaHome: async () => ({ ok: true, path: "" }),
      link: async () => ({ ok: true, path: "" }),
      createDirectory: async () => ({ ok: true, path: "" }),
      admits: async () => ({ ok: true, admitted: true }),
    },
    displayProfile: async () => ({
      refreshHz: 60,
      frameBudgetMs: 1000 / 60,
      scaleFactor: 1,
      hairlineCss: 1,
      width: 1440,
      height: 900,
      highDensity: false,
      highRefresh: false,
      css: {},
    }),
    onDisplayChange: () => () => {},
    onCloseRequest: () => () => {},
    onOpenPaths: () => () => {},
  });
  localStorage.setItem("refrain.roots", JSON.stringify([${JSON.stringify(workspace)}]));
`;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(
      Bun.file(join(root, "dist", "renderer", path === "/" ? "index.html" : path)),
      { headers: { "cache-control": "no-store" } },
    );
  },
});

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const failures: string[] = [];
const check = (claim: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(claim);
};

page.on("pageerror", (error) => console.log("PAGEERROR:", String(error).slice(0, 300)));
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(300);
await page.keyboard.press("Control+k");
await page.locator("nav.menu input").fill("文件");
await page.locator("nav.menu button.row").filter({ hasText: "文件浏览" }).click();
await page.locator("section.files input[type=search]").waitFor();

const input = page.locator("section.files input[type=search]");
await page.evaluate(() => window.__clearFileSearchCalls());
await input.pressSequentially("abc", { delay: 20 });
await page.waitForTimeout(120);
check(
  "rapid input does not search before the debounce window",
  (await page.evaluate(() => window.__fileSearchCalls.length)) === 0,
);
await page.waitForTimeout(160);
const burstCalls = await page.evaluate(() => window.__fileSearchCalls);
check(
  "rapid input coalesces to one search for the final query",
  burstCalls.length === 1 && burstCalls[0]?.query === "abc",
  JSON.stringify(burstCalls),
);
await page.evaluate(() => window.__resolveFileSearch("abc"));
await page.waitForFunction(
  () => document.querySelector("section.files .name")?.textContent === "abc.md",
);

await page.evaluate(() => window.__clearFileSearchCalls());
await input.fill("old");
await page.waitForTimeout(240);
await input.fill("new");
await page.waitForTimeout(240);
const orderedCalls = await page.evaluate(() => window.__fileSearchCalls.map(({ query }) => query));
check(
  "separated queries both reach the native boundary",
  orderedCalls.join(",") === "old,new",
  orderedCalls.join(","),
);
await page.evaluate(() => window.__resolveFileSearch("new"));
await page.waitForFunction(
  () => document.querySelector("section.files .name")?.textContent === "new.md",
);
await page.evaluate(() => window.__resolveFileSearch("old"));
await page.waitForTimeout(80);
check(
  "an older completion cannot replace the newest result",
  (await page.locator("section.files .name").textContent()) === "new.md",
  (await page.locator("section.files .name").textContent()) ?? "missing",
);

await input.fill("stale");
await page.waitForTimeout(240);
await input.fill("");
await page.waitForFunction(
  () => document.querySelector("section.files .name")?.textContent === "base-a.md",
);
await page.evaluate(() => window.__resolveFileSearch("stale"));
await page.waitForTimeout(80);
check(
  "clearing cancels pending search work and restores the current Root page",
  (await page.locator("section.files .name").textContent()) === "base-a.md",
  (await page.locator("section.files .name").textContent()) ?? "missing",
);

await browser.close();
server.stop();
if (failures.length > 0) {
  console.error(`\n${failures.length} F-14 claim(s) failed`);
  process.exit(1);
}
console.log("\nfile search: every F-14 claim holds");
