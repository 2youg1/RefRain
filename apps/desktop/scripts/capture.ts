/**
 * Render the real renderer bundle and capture what it actually looks like.
 *
 * Source code is weak evidence about visual quality: an earlier build shipped a
 * stray coloured caption band and a black default menu strip, neither visible
 * in any file I had written. This drives the built HTML in Chromium with a
 * stubbed preload bridge, so every screen can be inspected as pixels.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const shots = join(root, "shots");
mkdirSync(shots, { recursive: true });

const CHAPTERS = [
  {
    title: "01-夜行",
    root: "/home/author/novel",
    path: "/home/author/novel/01-夜行.md",
    text: `黑暗中有人问。

声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜，那时他也是这样开口的，隔着一层水汽，像怕惊动什么。

剑尖垂下去，抵住青石板。石面是凉的，凉意顺着剑脊爬上来，一直爬到虎口。

「你还是来了。」那个声音说。

她没有答。答什么都像是认了。`,
  },
  {
    title: "02-旧账",
    root: "/home/author/novel",
    path: "/home/author/novel/02.md",
    text: "第二章还没有开始写。",
  },
  {
    title: "附录",
    root: "/home/author/notes",
    path: "/home/author/notes/附录.md",
    text: "一些散记。",
  },
];

const LEDGER = [
  {
    id: "v1",
    proposalId: "run1:s-b2",
    sliceId: "p1.s2",
    kind: "accept-modified",
    finalText: "她握剑的手反而紧了半分。",
    reason: "「却」改「反而」，转折更硬",
    baseline: "rev0",
    decidedAt: "2026-07-26T09:14:00.000Z",
  },
  {
    id: "v2",
    proposalId: "run1:s-b2",
    sliceId: "p1.s1",
    kind: "reject",
    reason: "断句太碎，失了原来的绵长",
    baseline: "rev0",
    decidedAt: "2026-07-26T09:15:00.000Z",
  },
];

const EDITS = [
  {
    id: "e0-b2",
    kind: "replace",
    blockId: "b2",
    before: "声音很熟，熟到她握剑的手松了半分。",
    after: "声音很熟。她握剑的手反而紧了半分。",
    at: "2026-07-26T10:02:00.000Z",
    note: "转折要更硬",
  },
  {
    id: "e1-b5",
    kind: "insert",
    blockId: "b5",
    after: "她没有答。答什么都像是认了。",
    at: "2026-07-26T10:04:00.000Z",
  },
];

const bridge = `
  window.refrain = {
    openProject: async () => "/home/author/novel",
    openFile: async () => "/home/author/notes/附录.md",
    createProject: async () => "/home/author/novel",
    pathFor: () => "/home/author/novel",
    resolveDrop: async (p) => p,
    fullscreen: async () => true,
    loadProject: async () => ${JSON.stringify(CHAPTERS)},
    loadWorkspace: async () => ${JSON.stringify(CHAPTERS)},
    saveChapter: async () => true,
    systemFonts: async () => ["方正书宋", "方正楷体", "思源黑体", "华文中宋", "Times New Roman", "Georgia"],
    listAgents: async () => [
      { id: "a1", name: "kimi", binding: { harness: "command:kimi run", model: "unspecified", reasoningEffort: "unspecified" } },
      { id: "a2", name: "codex", binding: { harness: "file", model: "unspecified", reasoningEffort: "unspecified" } }
    ],
    probeAgent: async () => ({ ok: true, detail: "kimi 1.4.2" }),
    removeAgent: async () => true,
    addAgent: async (r, n) => ({ id: "a3", name: n, binding: { harness: "file", model: "unspecified", reasoningEffort: "unspecified" } }),
    enqueue: async () => true,
    manifest: async () => [],
    send: async () => [],
    collect: async () => ({ proposals: [], comments: [] }),
    runs: async () => [],
    commit: async () => ({ ok: true, text: "" }),
    ledger: async () => ${JSON.stringify(LEDGER)},
    reply: async () => "<changes>…</changes>",
    editsBetween: async () => ${JSON.stringify(EDITS)},
    revertEdit: async (t) => t,
    revertAll: async (t) => t,
    describeEdits: async () => "<edits>…</edits>",
  };
  localStorage.setItem("refrain.roots", JSON.stringify(["/home/author/novel", "/home/author/notes"]));
`;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(
      Bun.file(join(root, "dist", "renderer", path === "/" ? "index.html" : path)),
    );
  },
});
const origin = `http://localhost:${server.port}`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

const load = async (script = "", extra = ""): Promise<void> => {
  await page.addInitScript(bridge + extra);
  await page.goto(origin);

  /**
   * Both CJK faces are full-width, so advance width cannot tell them apart —
   * an earlier probe compared widths and wrongly reported fallback. Render the
   * same glyph under each family and compare pixels instead.
   */
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('17px "Chiron Sung HK"', "剑");
    await document.fonts.ready;
    const fingerprint = (family: string): string => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#000";
      ctx.font = `48px ${family}`;
      ctx.textBaseline = "top";
      ctx.fillText("剑", 4, 4);
      return canvas.toDataURL().slice(-96);
    };
    return fingerprint('"Chiron Sung HK"') !== fingerprint("monospace");
  });
  if (!loaded) throw new Error("Chiron Sung HK did not render — every screenshot would be wrong");

  await page.waitForTimeout(360);
  if (script) await page.evaluate(script);
  await page.waitForTimeout(320);
};

const shot = async (name: string): Promise<void> => {
  await page.screenshot({ path: join(shots, `${name}.png`) });
  console.log(`  captured ${name}.png`);
};

// 1 — first run
await page.addInitScript(`
  window.refrain = { openProject: async () => null, openFile: async () => null, createProject: async () => null };
  localStorage.removeItem("refrain.roots");
`);
await page.goto(origin);
await page.waitForTimeout(700);
await shot("01-welcome");

// 2 — writing, with the file tree
await load();
await shot("02-writing");

// 3 — the menu, from the left, over frosted glass
await page.keyboard.press("Control+k");
await page.waitForTimeout(420);
await shot("03-menu");
await page.keyboard.press("Escape");

// 4 — settings: typography
await load();
await page.keyboard.press("Control+,");
await page.waitForTimeout(400);
await page.getByRole("button", { name: "排版" }).first().click();
await page.waitForTimeout(420);
await shot("04-typography");

// 5 — settings: agents, showing connection state
await page.getByRole("button", { name: "Agent" }).first().click();
await page.waitForTimeout(600);
await shot("05-agents");

// 6 — what I changed
await load();
await page.evaluate(
  `document.querySelector('.manuscript').dispatchEvent(new Event('input', { bubbles: true }))`,
);
await page.keyboard.press("Control+s");
await page.waitForTimeout(300);
await page.keyboard.press("Control+h");
await page.waitForTimeout(420);
await shot("06-edits");

// 7 — the ink theme
await load("", `localStorage.setItem("refrain.theme", JSON.stringify("ink"));`);
await shot("07-ink");

// 8 — Zen
await load();
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(460);
await shot("08-zen");

await browser.close();
server.stop();
console.log("\nAll screens captured.");
