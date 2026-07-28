/**
 * Prove the header and the manuscript share one left edge, by measurement.
 *
 * Vision reads "roughly aligned" as aligned; the header sat 57px right of the
 * body it names for two rounds because both were centred against boxes of
 * different widths. Geometry does not have that problem.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Locator, Page } from "playwright";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ROOTS = [{ id: "r1", path: "/p", name: "p", kind: "folder" as const }];

const CHAPTERS = [
  {
    id: "01.md",
    title: "01-夜行",
    rootId: "r1",
    root: "/p",
    role: "chapter" as const,
    path: "/p/01.md",
    text: "黑暗中有人问。\n\n声音很熟。",
  },
];

export type AnchorMutation = "chapter" | "header" | "menu-input" | "menu-opener" | "sheet";

const MUTATIONS: readonly AnchorMutation[] = [
  "chapter",
  "header",
  "menu-input",
  "menu-opener",
  "sheet",
];

const missing = (label: string, selector: string): Error =>
  new Error(`FAIL  missing ${label}: selector ${selector} matched no elements`);

const requireTarget = async (page: Page, label: string, selector: string): Promise<Locator> => {
  const target = page.locator(selector);
  if ((await target.count()) === 0) throw missing(label, selector);
  return target.first();
};

const removeTargets = async (page: Page, selector: string): Promise<void> => {
  await page.locator(selector).evaluateAll((elements) => {
    for (const element of elements) element.remove();
  });
};

export const runAnchorGate = async (mutation?: AnchorMutation): Promise<void> => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      return new Response(
        Bun.file(join(root, "dist", "renderer", path === "/" ? "index.html" : path)),
        { headers: { "cache-control": "no-store" } },
      );
    },
  });
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(`
      ${BRIDGE_STUB}
      Object.assign(window.refrain, {
        openProject: async () => "/p",
        pathFor: () => "/p",
        loadProject: async () => ${JSON.stringify(CHAPTERS)},
        loadWorkspace: async () => ({
          roots: ${JSON.stringify(ROOTS)},
          chapters: ${JSON.stringify(CHAPTERS)},
        }),
      });
      localStorage.setItem("refrain.roots", JSON.stringify([]));
    `);
    await page.goto(`http://localhost:${server.port}`);
    await page.waitForTimeout(900);

    /*
     * The workspace loads through an explicit action. "打开项目" is the command a
     * person uses; `openProject` in the stub returns the fixture root, so this
     * drives the same path the application really takes instead of pre-seeding a
     * root that `addRoot` correctly treats as a duplicate.
     */
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    if (mutation === "menu-input") await removeTargets(page, "nav.menu input");
    const menuInput = await requireTarget(page, "command-menu input", "nav.menu input");
    await menuInput.fill("打开项目");
    await page.waitForTimeout(300);
    if (mutation === "menu-opener") await removeTargets(page, "nav.menu button.row");
    const opener = await requireTarget(page, "open-project command", "nav.menu button.row");
    await opener.click();
    await page.waitForTimeout(900);

    /*
     * The header renders only with a chapter open, and `Progress.svelte` also
     * carries a `.bar` class. Every target is asserted, so fixture and DOM drift
     * fail rather than manufacturing a measurement or quietly skipping one.
     */
    if (mutation === "chapter") await removeTargets(page, "nav .chapter");
    const chapter = await requireTarget(page, "chapter", "nav .chapter");
    const chapterCount = await page.locator("nav .chapter").count();
    console.log(`fixture: ${chapterCount} chapter(s) in the rail`);
    await chapter.click();
    await page.waitForTimeout(700);

    if (mutation === "header") await removeTargets(page, "header.bar");
    if (mutation === "sheet") await removeTargets(page, ".sheet-surface");
    await requireTarget(page, "chapter header", "header.bar");
    await requireTarget(page, "manuscript sheet", ".sheet-surface");

    const report = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rectangle = element.getBoundingClientRect();
        return { left: Math.round(rectangle.left), width: Math.round(rectangle.width) };
      };
      const rail = document.querySelector(".bar-rail");
      return {
        // `header.bar`, not `.bar`: Progress.svelte uses the same class name.
        bar: box("header.bar"),
        barRail: box(".bar-rail"),
        sheet: box(".sheet-surface"),
        measure: getComputedStyle(document.documentElement).getPropertyValue(
          "--manuscript-measure",
        ),
        railWidth: rail ? getComputedStyle(rail).width : "(no .bar-rail)",
      };
    });

    console.log(JSON.stringify(report, null, 2));
    if (!report.bar) throw missing("chapter header", "header.bar");
    if (!report.sheet) throw missing("manuscript sheet", ".sheet-surface");

    const drift = Math.abs(report.bar.left - report.sheet.left);
    console.log("\n--- verdict ---");
    console.log(`bar   left ${report.bar.left}  width ${report.bar.width}`);
    console.log(`sheet left ${report.sheet.left}  width ${report.sheet.width}`);
    console.log(`drift ${drift}px`);
    if (drift > 1)
      throw new Error(`FAIL  the column does not hang from one line: drift ${drift}px`);
    console.log("PASS  one left edge");
  } finally {
    await browser?.close();
    server.stop(true);
  }
};

if (import.meta.main) {
  try {
    const requested = process.argv.find((argument) => argument.startsWith("--remove-target="));
    const mutation = requested?.slice("--remove-target=".length);
    if (mutation !== undefined && !MUTATIONS.includes(mutation as AnchorMutation))
      throw new Error(`FAIL  unknown anchor mutation: ${mutation}`);
    await runAnchorGate(mutation as AnchorMutation | undefined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
