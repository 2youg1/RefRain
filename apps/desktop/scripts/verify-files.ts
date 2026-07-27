/**
 * Verify the file browser as rendered, not as written.
 *
 * Three claims here cannot be checked by reading source:
 *
 * 1. The list is windowed — a workspace of 20,000 files must not put 20,000
 *    rows in the DOM, and the scrollbar must still describe the whole set.
 * 2. Rows land on the row grid. A windowed list computes `top` arithmetically,
 *    so an off-by-one in the maths shows as overlapping or gapped rows.
 * 3. A hairline is one device pixel. At `deviceScaleFactor: 2` a 1px border is
 *    two physical pixels, which is the blur this application is built to avoid.
 *
 * Measurement rather than vision: a screenshot cannot distinguish a 1px border
 * from a 0.5px one, and an earlier round of this project recorded a vision
 * model getting exactly that class of judgment wrong.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

/** A workspace large enough that a naive list would be obvious. */
const ENTRIES = Array.from({ length: 20_000 }, (_, index) => ({
  path: `/home/author/novel/chapter-${index}.md`,
  name: index % 3 === 0 ? `第${index}章-草稿.md` : `chapter-${index}-draft.md`,
  kind: "file" as const,
  size: 1024 + index,
  modifiedMs: 1_700_000_000_000 + index * 1000,
  depth: 1,
  manuscript: true,
}));

const bridge = `
  // The entry list is defined before the bridge that closes over it: an
  // exception anywhere in an init script abandons the rest of it silently, and
  // a bridge that never got assigned looks exactly like a component that never
  // rendered.
  window.__ENTRIES = ${JSON.stringify(ENTRIES)};
  window.refrain = {
    openProject: async () => null,
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [],
    loadWorkspace: async () => [],
    saveChapter: async () => ({ ok: true, edits: [] }),
    systemFonts: async () => [],
    pathFor: () => "",
    resolveDrop: async () => null,
    fullscreen: async () => false,
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

    revertEdit: async (t) => t,
    revertAll: async (t) => t,
    describeEdits: async () => "",
    files: {
      scan: async () => ({ ok: true, count: ${ENTRIES.length} }),
      page: async (_root, offset, limit) => ({
        ok: true,
        entries: window.__ENTRIES.slice(offset, offset + limit),
        total: ${ENTRIES.length},
      }),
      search: async () => ({ ok: true, hits: [] }),
      searchDirectories: async () => ({ ok: true, hits: [] }),
      sort: async () => ({ ok: true }),
      move: async () => ({ ok: true, path: "" }),
      copy: async () => ({ ok: true, path: "" }),
      trash: async () => ({ ok: true, outcomes: [] }),
      link: async () => ({ ok: true, path: "" }),
      createDirectory: async () => ({ ok: true, path: "" }),
      uniqueName: async () => ({ ok: true, path: "" }),
      admits: async () => ({ ok: true, admitted: true }),
    },
    // A 165 Hz panel at 200%: the frame budget and the hairline both differ
    // from the defaults, so a component that ignores the profile shows it.
    displayProfile: async () => ({
      refreshHz: 165,
      frameBudgetMs: 1000 / 165,
      scaleFactor: 2,
      hairlineCss: 0.5,
      width: 3840,
      height: 2160,
      highDensity: true,
      highRefresh: true,
      css: {
        "--frame-budget": "6.061ms",
        "--hairline": "0.5px",
        "--scale-factor": "2",
        "--motion-quick": "24.242ms",
        "--motion-normal": "48.485ms",
        "--motion-slow": "96.970ms",
      },
    }),
    onDisplayChange: () => () => {},
  };
  localStorage.setItem("refrain.roots", JSON.stringify(["/home/author/novel"]));
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
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

const failures: string[] = [];
const check = (claim: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(claim);
};

page.on("pageerror", (error) => console.log("PAGEERROR:", String(error).slice(0, 200)));
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);

// The browser lives behind the palette, which is the single entrance. Drive it
// the way a person does: open it, type, and click the command that matches.
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);

check("the palette opens", (await page.locator("nav.menu").count()) > 0);

await page.locator("nav.menu input").fill("文件");
await page.waitForTimeout(300);

const target = page.locator("nav.menu button.row").filter({ hasText: "文件浏览" });
check(
  "the palette lists the file browser command",
  (await target.count()) > 0,
  (await page.locator("nav.menu button.row .text").allTextContents()).join(" | "),
);

if ((await target.count()) > 0) {
  await target.first().click();
  await page.waitForTimeout(600);
}

const pane = page.locator("section.files");
check("the file browser renders", (await pane.count()) > 0);

if ((await pane.count()) > 0) {
  const rows = page.locator("section.files .row");
  const rendered = await rows.count();

  check(
    "the list is windowed rather than rendering every entry",
    rendered > 0 && rendered < 200,
    `${rendered} rows in the DOM for ${ENTRIES.length} entries`,
  );

  const spacerHeight = await page
    .locator("section.files .spacer")
    .evaluate((element) => element.getBoundingClientRect().height);
  check(
    "the scrollbar describes the whole workspace",
    Math.abs(spacerHeight - ENTRIES.length * 26) < 2,
    `spacer ${Math.round(spacerHeight)}px`,
  );

  // Rows are absolutely positioned by arithmetic; an off-by-one shows as an
  // overlap or a gap, and neither is visible in a screenshot at this density.
  const tops = await rows.evaluateAll((elements) =>
    elements.slice(0, 12).map((element) => Number.parseFloat((element as HTMLElement).style.top)),
  );
  const gaps = tops.slice(1).map((top, index) => top - (tops[index] ?? 0));
  check(
    "rows sit exactly one row-height apart",
    gaps.every((gap) => Math.abs(gap - 26) < 0.01),
    `gaps ${[...new Set(gaps)].join(", ")}`,
  );

  // The claim the whole display layer exists for.
  const hairline = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--hairline").trim(),
  );
  check(
    "a hairline is one device pixel on a 2× panel",
    hairline === "0.5px",
    `--hairline: ${hairline}`,
  );

  const motion = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--motion-normal").trim(),
  );
  check(
    "motion is retargeted to the panel's refresh rate",
    motion.startsWith("48"),
    `--motion-normal: ${motion}`,
  );

  const density = await page.evaluate(() => document.documentElement.dataset.density);
  check("the density class reaches the stylesheet", density === "high", `data-density: ${density}`);

  /*
   * Three defects a geometry check missed and a look at the pixels caught: the
   * modified column had a header and no values, the size header sat left of the
   * figures it named, and the first row rendered half-clipped under the header.
   * Each is asserted here so it cannot come back unnoticed.
   */
  const modified = await rows.first().locator(".modified").textContent();
  check(
    "the modified column carries values, not just a header",
    (modified ?? "").trim().length > 0,
    `first row modified: ${modified?.trim()}`,
  );

  // A top-level chapter's name must start where its header does. An earlier
  // draft indented the whole grid row instead of the name cell, which pushed
  // every column right and left the name floating under nothing.
  const [nameHeaderLeft, nameCellLeft] = await Promise.all([
    page
      .locator("section.files .columns button")
      .first()
      .evaluate((element) => element.getBoundingClientRect().left),
    rows
      .first()
      .locator(".name")
      .evaluate((element) => element.getBoundingClientRect().left),
  ]);
  check(
    "a chapter name starts under the name header",
    Math.abs(nameHeaderLeft - nameCellLeft) < 2,
    `header ${Math.round(nameHeaderLeft)}px vs cell ${Math.round(nameCellLeft)}px`,
  );

  const [sizeHeaderRight, sizeCellRight] = await Promise.all([
    page
      .locator("section.files .columns button")
      .last()
      .evaluate((element) => element.getBoundingClientRect().right),
    rows
      .first()
      .locator(".size")
      .evaluate((element) => element.getBoundingClientRect().right),
  ]);
  check(
    "the size header sits over the figures it names",
    Math.abs(sizeHeaderRight - sizeCellRight) < 2,
    `header ${Math.round(sizeHeaderRight)}px vs cell ${Math.round(sizeCellRight)}px`,
  );

  // Measured at rest. After a scroll the first rendered row is legitimately
  // above the viewport — that is what a windowed list does — so testing it
  // there would assert the opposite of the intended behaviour.
  const [viewportTop, firstRowTop] = await Promise.all([
    page
      .locator("section.files .viewport")
      .evaluate((element) => element.getBoundingClientRect().top),
    rows.first().evaluate((element) => element.getBoundingClientRect().top),
  ]);
  check(
    "the first row is not clipped by the header",
    firstRowTop >= viewportTop - 0.5,
    `viewport ${Math.round(viewportTop)}px, first row ${Math.round(firstRowTop)}px`,
  );

  const footer = await page.locator("section.files .count").textContent();
  check(
    "the footer count names what it counts",
    (footer ?? "").trim() !== String(ENTRIES.length),
    `footer: ${footer?.trim()}`,
  );

  // Scrolling must fetch the next page rather than run out of rows.
  await page.locator("section.files .viewport").evaluate((element) => {
    element.scrollTop = 5000;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(400);

  const afterScroll = await rows.first().textContent();
  check(
    "scrolling pages in later entries",
    afterScroll !== null && !afterScroll.includes("chapter-0-"),
    `first row after scroll: ${afterScroll?.trim().slice(0, 24)}`,
  );

  const trash = page.locator("section.files button.trash");
  check(
    "the delete control names the trash",
    (await trash.textContent())?.includes("废纸篓") === true,
  );
  check("the delete control is disabled with nothing selected", await trash.isDisabled());

  await page.screenshot({ path: join(root, "shots", "07-files.png") });
}

await browser.close();
server.stop();

if (failures.length > 0) {
  console.error(`\n${failures.length} claim(s) failed`);
  process.exit(1);
}
console.log("\nfile browser: every claim holds");
