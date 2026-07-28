/**
 * The manuscript is a plain-text surface, and emphasis is literal Markdown.
 *
 * `app.css` carried `.manuscript :is(em, i) { font-style: italic }` for as long
 * as the manuscript has existed, and it never applied to anything: `render`
 * sets `p.textContent`, so no inline Markdown ever becomes an element. The rule
 * was also wrong for the languages this application is for — CJK has no italic,
 * the browser slants the glyphs geometrically, and the strokes collapse.
 * `Rail.svelte` said so in a comment while the stylesheet contradicted it, and
 * neither could be caught, because neither ever ran.
 *
 * Two facts are asserted here, because deleting the rule proves neither on its
 * own: Ctrl+I inserts the characters an author would have typed, and the
 * manuscript holds no element that would have taken the deleted rule. The
 * second is what makes the deletion safe, and what will fail the day inline
 * rendering arrives — at which point emphasis has to come back scoped by
 * `:lang`, 着重号 for CJK and italic for Latin, rather than one rule for every
 * script.
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

const CHAPTER = "他走了。天亮了。\n";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(`
  localStorage.clear();
  localStorage.setItem("refrain.roots", JSON.stringify(["/p"]));
  ${BRIDGE_STUB}
  Object.assign(window.refrain, {
    openProject: async () => "/p",
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [],
    loadWorkspace: async () => ({
      roots: [{ id: "r1", path: "/p", name: "p", kind: "folder" }],
      chapters: [{ id: "01.md", title: "01", text: ${JSON.stringify(CHAPTER)},
        rootId: "r1", root: "/p", role: "chapter", path: "/p/01.md" }],
    }),
    saveChapter: async () => ({ ok: true, edits: [] }),
    resolveConflict: async () => ({ ok: false, reason: "not expected" }),
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
    reply: async () => "",
    searchLedger: async () => ({ ok: true, verdicts: [] }),
    revertEdit: async (t) => t,
    revertAll: async (t) => t,
    describeEdits: async () => "",
  });
`);

const fail = async (message: string): Promise<never> => {
  console.error(`FAIL  ${message}`);
  await browser.close();
  server.stop();
  process.exit(1);
};

try {
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(600);

  const opened = await page.locator(".manuscript > p").count();
  if (opened === 0) await fail("the manuscript never rendered — the fixture did not open");

  // Select 走了 and ask for emphasis the way an author would.
  await page.evaluate(() => {
    const paragraph = document.querySelector<HTMLElement>(".manuscript > p");
    const text = paragraph?.firstChild;
    if (!paragraph || !text) throw new Error("no paragraph to select inside");
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Control+i");
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    text: document.querySelector<HTMLElement>(".manuscript")?.textContent ?? "",
    elements: document.querySelectorAll(".manuscript :is(em, i, strong, b)").length,
  }));

  if (!after.text.includes("*走了*"))
    await fail(`emphasis did not insert literal Markdown: ${JSON.stringify(after.text)}`);

  if (after.elements > 0)
    await fail(
      `the manuscript now holds ${after.elements} inline element(s); emphasis styling has to ` +
        "come back scoped by :lang — 着重号 for CJK, italic for Latin",
    );

  console.log("PASS  emphasis stays literal Markdown and the manuscript holds no inline elements");
} finally {
  await browser.close();
  server.stop();
}
