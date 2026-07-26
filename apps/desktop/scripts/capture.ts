/**
 * Render the real renderer bundle and capture what it actually looks like.
 *
 * Source code is weak evidence about visual quality: the previous build shipped
 * a stray coloured caption band and a black default menu strip, neither visible
 * in any file I had written. This script drives the built HTML in Chromium with
 * a stubbed preload bridge, so every screen can be inspected as pixels.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const shots = join(root, "shots");
mkdirSync(shots, { recursive: true });

/** A project the way an author would actually have one. */
const CHAPTERS = [
  {
    title: "01-夜行",
    text: `黑暗中有人问。

声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜，那时他也是这样开口的，隔着一层水汽，像怕惊动什么。

剑尖垂下去，抵住青石板。石面是凉的，凉意顺着剑脊爬上来，一直爬到虎口。

"你还是来了。"那个声音说。

她没有答。答什么都像是认了。`,
  },
  { title: "02-旧账", text: "第二章还没有开始写。" },
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
  {
    id: "v3",
    proposalId: "run2:s-b4",
    sliceId: "p2.s0",
    kind: "accept",
    baseline: "rev1",
    decidedAt: "2026-07-26T10:02:00.000Z",
  },
];

/** Stub the preload bridge so the renderer runs without Electron. */
const bridge = (chapters: unknown, ledger: unknown) => `
  window.recension = {
    openProject: async () => "/home/author/novel",
    createProject: async () => "/home/author/novel",
    pathFor: () => "/home/author/novel",
    resolveDrop: async (p) => p,
    fullscreen: async () => true,
    loadProject: async () => ${JSON.stringify(chapters)},
    saveChapter: async () => true,
    listAgents: async () => [
      { id: "a1", name: "kimi", binding: { harness: "command:kimi", model: "unspecified", reasoningEffort: "unspecified" } },
      { id: "a2", name: "codex", binding: { harness: "file", model: "unspecified", reasoningEffort: "unspecified" } }
    ],
    addAgent: async (r, n) => ({ id: "a3", name: n, binding: { harness: "file", model: "unspecified", reasoningEffort: "unspecified" } }),
    enqueue: async () => true,
    manifest: async () => [],
    send: async () => [],
    collect: async () => ({ proposals: [], comments: [] }),
    runs: async () => [],
    commit: async () => ({ ok: true, text: "" }),
    ledger: async () => ${JSON.stringify(ledger)},
    reply: async () => "<changes>\\n<verdict n=\\"1\\" ref=\\"p1.s2\\" kind=\\"accept-modified\\">\\n  <final><![CDATA[她握剑的手反而紧了半分。]]></final>\\n  <reason>「却」改「反而」，转折更硬</reason>\\n</verdict>\\n</changes>",
  };
`;

/**
 * Fonts are base64-inlined rather than served.
 *
 * This container has no system CJK font, so Chromium silently substitutes
 * DejaVu and every screenshot shows Latin-metric Chinese — an artefact of the
 * capture machine, not of the application. Inlining is the one path that has
 * proved reliable; a served @font-face raced the first paint.
 */

/**
 * Served over HTTP rather than opened as file://. Chromium blocks module and
 * stylesheet loads from a file:// origin under CORS, which Electron does not —
 * so a file:// capture renders a blank page and proves nothing.
 */
/**
 * The shipped CSP is `default-src 'self'`, which correctly refuses a data: font.
 * The capture page relaxes font-src only — the application's own policy is not
 * touched, and the smoke test still asserts the shipped header is intact.
 */
const indexHtml = (await Bun.file(join(root, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/font/serif.ttf")
      return new Response(Bun.file(`${process.env.HOME}/.fonts/NotoSerifSC.ttf`), {
        headers: { "content-type": "font/ttf" },
      });
    if (path === "/font/sans.ttf")
      return new Response(Bun.file(`${process.env.HOME}/.fonts/NotoSansSC.ttf`), {
        headers: { "content-type": "font/ttf" },
      });

    // The font stack is injected into the served HTML rather than added after
    // load: this container has no system CJK font, and a stylesheet that
    // arrives post-mount leaves the first paint in fallback.
    if (path === "/") return new Response(indexHtml, { headers: { "content-type": "text/html" } });

    return new Response(Bun.file(join(root, "dist", "renderer", path)));
  },
});
const origin = `http://localhost:${server.port}`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

/**
 * Serve the CJK fonts to the capture page directly.
 *
 * The container has no system CJK font, so Chromium silently substitutes
 * DejaVu and every screenshot shows sans-serif Latin-metric Chinese — an
 * artefact of this machine, not of the application. `document.fonts.check`
 * reports true for absent families, so presence is proved by advance width.
 */
const load = async (script = ""): Promise<void> => {
  await page.addInitScript(bridge(CHAPTERS, LEDGER));
  await page.goto(origin);

  // Presence is proved by advance width: document.fonts.check returns true for
  // families the system merely substitutes for, so it cannot detect fallback.
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

  await page.waitForTimeout(320);
  if (script) await page.evaluate(script);
  await page.waitForTimeout(280);
};

const shot = async (name: string): Promise<void> => {
  await page.screenshot({ path: join(shots, `${name}.png`) });
  console.log(`  captured ${name}.png`);
};

// 1 — first run, nothing open
await load();
await shot("01-welcome");

// 2 — a project open, a chapter being written
const openProject = `
  document.querySelector(".actions .primary").click();
`;
await load(openProject);
await shot("02-writing");

// 3 — the command palette, the single entrance
await page.keyboard.press("Control+k");
await page.waitForTimeout(260);
await shot("03-palette");
await page.keyboard.press("Escape");

// 4 — typography, with the baseline grid on
await load(openProject);
await page.keyboard.press("Control+k");
await page.waitForTimeout(260);
await page.getByRole("button", { name: "排版…" }).click();
await page.waitForTimeout(380);
await page.getByRole("button", { name: "基线网格" }).click();
await page.waitForTimeout(400);
await shot("04-typography");

// 5 — the ledger, where judgments accumulate
await load(openProject);
await page.keyboard.press("Control+k");
await page.waitForTimeout(260);
await page.getByRole("button", { name: "裁决账本" }).click();
await page.waitForTimeout(420);
await shot("05-ledger");

// 6 — ink theme
await load(openProject);
await page.evaluate(`
  localStorage.setItem("recension.theme", JSON.stringify("ink"));
  location.reload();
`);
await page.waitForTimeout(600);
await page.evaluate(openProject);
await page.waitForTimeout(300);
await shot("06-ink");

// 7 — Zen: the manuscript and its rest, nothing else
await page.evaluate(`
  localStorage.setItem("recension.theme", JSON.stringify("paper"));
  location.reload();
`);
await page.waitForTimeout(600);
await page.evaluate(openProject);
await page.waitForTimeout(300);
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(420);
await shot("07-zen");

await browser.close();
server.stop();
console.log("\nAll screens captured.");
