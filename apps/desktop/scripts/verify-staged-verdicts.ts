/**
 * Judgments survive the panel being dismissed, and a refused merge.
 *
 * The review panel lives in a sheet that unmounts on Escape. Owning the staged
 * verdicts inside it meant a reader who judged several slices, pressed Escape
 * to look at the paragraph they were judging, and reopened the panel found an
 * empty list — and the same component cleared them on Merge before learning
 * whether the merge had succeeded, so a refusal destroyed what it refused.
 *
 * Both are invisible to a type check and to every unit test, because both are
 * about a component's lifetime.
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
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/index.html")
      return new Response(html, {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      });
    const file = Bun.file(join(root, "dist", "renderer", path));
    return (await file.exists())
      ? new Response(file, { headers: { "cache-control": "no-store" } })
      : new Response("not found", { status: 404 });
  },
});

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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

// One proposal with two judgable slices, and a commit that always refuses —
// so the refusal path is exercised without needing a real merge to fail.
await page.addInitScript(`window.refrain = {
  openProject: async () => "/w", openFile: async () => null, createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  loadProject: async () => [], saveChapter: async () => ({ ok: true, edits: [] }),
  loadWorkspace: async (roots) => ({
    roots: [{ id: "r1", path: roots[0], name: "w", kind: "folder" }],
    chapters: [{ id: "01.md", title: "01", text: "他走了。天亮了。",
      rootId: "r1", root: roots[0], role: "chapter", path: roots[0] + "/01.md" }] }),
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [],
  runs: async () => [{ id: "run1", agentId: "a1", agentName: "probe", state: "collected",
    task: "t1", scopeIds: ["s1"], startedAt: "2026-01-01T00:00:00Z", workspace: "/w/run1" }],
  collect: async () => ({
    proposals: [{
      id: "p7", runId: "run1", baseline: "rev0",
      scope: { id: "s1", blockIds: ["b0"] },
      before: "他走了。天亮了。", after: "他离开了。天亮了。",
      slices: [
        { id: "p7.s0", kind: "del", text: "他走了。" },
        { id: "p7.s1", kind: "ins", text: "他离开了。" },
        { id: "p7.s2", kind: "same", text: "天亮了。" },
      ],
    }],
    comments: [],
  }),
  commit: async () => ({ ok: false, reason: "stale-baseline", detail: ["p7"] }),
  ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {},
  fonts: async () => [], systemFonts: async () => [],
};`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);

const opened = await page.evaluate(() => {
  const button = [...document.querySelectorAll<HTMLElement>("button")].find((node) =>
    /打开文件夹|Open folder/.test(node.textContent ?? ""),
  );
  button?.click();
  return button !== undefined;
});
if (!opened) await fail("the welcome screen offers no way to open a folder");
await page.waitForTimeout(600);

/** Open the review sheet through the palette, the way an author would. */
// Proposals arrive by collecting a finished run, which is how they arrive in
// the application. Reaching into the panel without that would test a fixture.
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
const openedRuns = await page.evaluate(() => {
  const entry = [...document.querySelectorAll<HTMLElement>("button, li, [role=option]")].find(
    (node) => /^\s*(交给 Agent…|Send to an agent…)(\s|$)/.test(node.textContent ?? ""),
  );
  entry?.click();
  return entry !== undefined;
});
if (!openedRuns) await fail("the command palette has no dispatch entry to reach runs through");
await page.waitForTimeout(500);

const collected = await page.evaluate(() => {
  const button = [...document.querySelectorAll<HTMLElement>("button")].find((node) =>
    /读取结果|Collect/.test(node.textContent ?? ""),
  );
  button?.click();
  return button !== undefined;
});
if (!collected) await fail("no way to collect the finished run");
await page.waitForTimeout(700);

// Collecting switches the sheet to review on its own. Pressing Ctrl+K again
// here would toggle the sheet shut, so check before reaching for the palette.
if (!(await page.evaluate(() => !!document.querySelector(".review"))))
  await fail("the review panel did not appear after collecting a run");

/** How many verdicts the commit bar says are staged. */
const stagedCount = (): Promise<number> =>
  page.evaluate(() => {
    const bar = document.querySelector(".commit-bar span");
    return Number.parseInt(bar?.textContent?.trim() ?? "0", 10) || 0;
  });

const judgeFirst = async (): Promise<boolean> =>
  page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLElement>(".review button")].find((node) =>
      /接受|Accept/.test(node.textContent ?? ""),
    );
    button?.click();
    return button !== undefined;
  });

if (!(await judgeFirst())) await fail("the review panel offers no way to accept a slice");
await page.waitForTimeout(300);

const afterJudging = await stagedCount();
if (afterJudging < 1)
  await fail(`judging a slice staged nothing, the commit bar reads ${afterJudging}`);

// Escape dismisses the sheet — the thing an author does to look at the text.
await page.keyboard.press("Escape");
await page.waitForTimeout(350);
const sheetGone = await page.evaluate(() => document.querySelector(".sheet") === null);
if (!sheetGone) await fail("Escape did not dismiss the review sheet, so this proves nothing");

await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
const reopened = await page.evaluate(() => {
  const entry = [...document.querySelectorAll<HTMLElement>("button, li, [role=option]")].find(
    (node) => /^\s*(审阅提案|Review proposals)(\s|$)/.test(node.textContent ?? ""),
  );
  entry?.click();
  return entry !== undefined;
});
if (!reopened) await fail("the command palette has no entry to reopen the review panel");
await page.waitForTimeout(450);
if (!(await page.evaluate(() => !!document.querySelector(".review"))))
  await fail("the review sheet did not reopen");

const afterReopen = await stagedCount();
if (afterReopen !== afterJudging)
  await fail(
    `${afterJudging} verdict(s) were staged, and ${afterReopen} survived dismissing the panel`,
  );

// A refused merge must leave the judgments where they are.
const merged = await page.evaluate(() => {
  const button = [...document.querySelectorAll<HTMLElement>(".commit-bar button")].find((node) =>
    /合并|Merge/.test(node.textContent ?? ""),
  );
  button?.click();
  return button !== undefined;
});
if (!merged) await fail("the commit bar offers no Merge button");
await page.waitForTimeout(500);

const afterRefusal = await stagedCount();
if (afterRefusal !== afterJudging)
  await fail(
    `the merge was refused, and ${afterJudging - afterRefusal} of ${afterJudging} verdict(s) ` +
      "were destroyed with it",
  );

await teardown();
console.log(
  `PASS  ${afterJudging} verdict(s) survived Escape and a refused merge (${afterReopen}, ${afterRefusal})`,
);
