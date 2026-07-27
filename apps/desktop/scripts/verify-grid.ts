/**
 * Prove the ruled lines land under the glyphs, by geometry rather than by eye.
 *
 * Vision misreads this: a rule a pixel below the descender and a rule through
 * the character both read as "a line near the text" in a screenshot. The line
 * box positions and the gradient stop are numbers, so they can simply be
 * compared.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = (await Bun.file(join(root, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, "dist", "renderer", p)));
  },
});

const LONG =
  "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜，那时他也是这样开口的，隔着一层水汽，像怕惊动什么。";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// The stub answers `loadWorkspace`, which is what the renderer calls. It used
// to answer only the older `loadProject`, so the workspace came back empty,
// no paragraph was ever rendered, and the gate measured nothing — while
// exiting zero.
await page.addInitScript(`window.refrain = {
  openProject: async () => "/p", openFile: async () => null, createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  loadProject: async () => [], saveChapter: async () => ({ ok: true, edits: [] }),
  loadWorkspace: async (roots) => ({
    roots: [{ id: "r1", path: roots[0], name: "w", kind: "folder" }],
    chapters: [{ id: "01.md", title: "01", text: ${JSON.stringify(LONG)},
      rootId: "r1", root: roots[0], role: "chapter", path: roots[0] + "/01.md" }] }),
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {},
  fonts: async () => [], systemFonts: async () => [],
};`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);

/**
 * Every failure path has to close the browser and the port. Exiting straight
 * from a check leaves a Chromium and a listening socket behind on a CI runner,
 * which is the same defect the type gate in this repository just learned to
 * avoid — one file learning `finally` while another grows four leaks.
 */
let torndown = false;
const teardown = async (): Promise<void> => {
  if (torndown) return;
  torndown = true;
  await browser.close();
  server.stop();
};

const fail = async (why: string): Promise<never> => {
  console.error(`FAIL  ${why}`);
  await teardown();
  process.exit(1);
};

const openedWorkspace = await page.evaluate(() => {
  const button = [...document.querySelectorAll<HTMLElement>("button")].find((node) =>
    /打开文件夹|Open folder/.test(node.textContent ?? ""),
  );
  button?.click();
  return button !== undefined;
});
if (!openedWorkspace) await fail("the welcome screen offers no way to open a folder");
await page.waitForTimeout(600);

// Turn the grid on through the interface, the way an author would. Typography
// is a section of Settings; the palette used to carry a second entry straight
// to it, and this gate silently stopped measuring anything when that duplicate
// was removed — it printed its verdict and exited zero either way.
await page.keyboard.press("Control+k");
await page.waitForTimeout(250);
const openedSettings = await page.evaluate(() => {
  const entry = [...document.querySelectorAll<HTMLElement>("button, li, [role=option]")].find(
    (node) => /^\s*(设置…|Settings…)(\s|$)/.test(node.textContent ?? ""),
  );
  entry?.click();
  return entry !== undefined;
});
if (!openedSettings)
  await fail("the command palette has no Settings entry to reach typography through");
await page.waitForTimeout(450);

const openedTypography = await page.evaluate(() => {
  const tab = [...document.querySelectorAll<HTMLElement>("button, li, [role=tab]")].find((node) =>
    /排版|Typography/.test(node.textContent ?? ""),
  );
  tab?.click();
  return tab !== undefined;
});
if (!openedTypography) await fail("Settings has no typography section");
await page.waitForTimeout(400);

// The switch carries no text of its own; its name is on the aria-label.
const gridToggled = await page.evaluate(() => {
  const toggle = [...document.querySelectorAll<HTMLElement>("button[aria-label]")].find((node) =>
    /基线网格|Baseline grid/.test(node.getAttribute("aria-label") ?? ""),
  );
  toggle?.click();
  return toggle !== undefined;
});
if (!gridToggled) await fail("the typography panel offers no baseline-grid control");
await page.waitForTimeout(400);

const report = await page.evaluate(() => {
  const paragraph = document.querySelector<HTMLElement>(".manuscript > p");
  if (!paragraph) return { error: "no paragraph" };

  const style = getComputedStyle(paragraph);
  const size = Number.parseFloat(style.fontSize);
  const lineBox = Number.parseFloat(style.lineHeight);
  const fontLine = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--font-line") || "1.16",
  );

  // Where each glyph run actually sits, measured from the paragraph's top.
  const range = document.createRange();
  const node = paragraph.firstChild;
  if (!node) return { error: "empty paragraph" };

  const top = paragraph.getBoundingClientRect().top;
  const lines: { top: number; bottom: number }[] = [];
  for (const rect of range.getClientRects.call(
    (() => {
      range.selectNodeContents(paragraph);
      return range;
    })(),
  ))
    lines.push({ top: rect.top - top, bottom: rect.bottom - top });

  /**
   * Read where the rule is actually drawn, rather than recomputing it here.
   *
   * This recomputed `--rule-at` from the other custom properties, which meant
   * the gate compared its own arithmetic against its own arithmetic: changing
   * the real declaration to draw the rule straight through the glyphs left it
   * passing. The stylesheet's computed value is the only witness that answers
   * the question the gate is asking.
   */
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:var(--rule-at)";
  paragraph.append(probe);
  const ruleAt = probe.getBoundingClientRect().height;
  probe.remove();
  if (!Number.isFinite(ruleAt) || ruleAt <= 0)
    return { error: `--rule-at did not resolve to a length, measured ${ruleAt}` };

  return {
    size,
    lineBox,
    fontLine,
    ruleAt: Math.round(ruleAt * 100) / 100,
    lineCount: lines.length,
    lines: lines.map((l) => ({
      top: Math.round(l.top * 10) / 10,
      bottom: Math.round(l.bottom * 10) / 10,
    })),
    backgroundImage: style.backgroundImage.slice(0, 90),
  };
});

console.log(JSON.stringify(report, null, 2));

await teardown();

if ("error" in report)
  await fail(`the page did not render a paragraph to measure: ${report.error}`);
if (!report.lines || report.lines.length < 2)
  await fail(
    `expected the sample paragraph to wrap onto at least two lines, saw ${report.lines?.length ?? 0}`,
  );

const [first, second] = report.lines as { top: number; bottom: number }[];
const gap = Math.round((second.top - first.bottom) * 10) / 10;
const ruleAt = report.ruleAt ?? 0;

console.log("\n--- verdict ---");
console.log(`line box            : ${report.lineBox}px`);
console.log(`rule drawn at       : ${ruleAt}px from each line's top`);
console.log(`line 1 glyph bottom : ${first.bottom}px`);
console.log(`line 2 glyph top    : ${second.top}px`);
console.log(`gap between lines   : ${gap}px`);

if (ruleAt < first.bottom)
  await fail(
    `the baseline rule is drawn ${ruleAt}px down, above the first line's glyph bottom at ` +
      `${first.bottom}px — it crosses the glyphs`,
  );

console.log("PASS  the rule sits below the glyphs");
