/**
 * The outside-edit dialog renders, and offers a real choice.
 *
 * This is the only modal in the application, and it exists at the one moment
 * where two versions of the author's writing both exist. A dialog that showed
 * only one of them, or whose buttons were indistinguishable, would be worse
 * than the silent overwrite it replaces — the author would click through it.
 *
 * So this asserts what a person needs: both texts visible, two distinct
 * actions, and nothing written until one is pressed.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const html = (await Bun.file(join(root, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, "dist", "renderer", path)));
  },
});

const MINE = "我这边写的一句，还没有保存。\n\n第二段也是我写的。";
const THEIRS = "别处改写过的一句，长度也不一样。\n\n第二段被换掉了。";
const DURING_SAVE = "保存等待时继续写的字。";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// The bridge is stubbed whole. `saveChapter` refuses the way main does when the
// file has moved on; `resolveConflict` is the only operation allowed after the
// author chooses. The old reload-then-save pair remains as a tripwire.
await page.addInitScript(`
  window.__calls = [];
  ${BRIDGE_STUB}
  Object.assign(window.refrain, {
    openProject: async () => "/p",
    loadProject: async () => [{ id: "01.md", title: "01", text: ${JSON.stringify(MINE)} }],
    loadWorkspace: async () => ({
      roots: [{ id: "r-p", path: "/p", name: "p", kind: "folder" }],
      chapters: [
        { id: "01.md", title: "01", text: ${JSON.stringify(MINE)}, root: "/p",
          rootId: "r-p", role: "chapter", path: "/p/01.md" },
      ],
    }),
    createProject: async () => null, pathFor: () => "", resolveDrop: async () => null,
    fullscreen: async () => true,
    onCloseRequest: () => () => {},
    saveChapter: async (root, title, text) => {
      window.__calls.push(["save", title, text]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: false, reason: "changed-underneath", path: "/p/01.md",
               onDisk: ${JSON.stringify(THEIRS)} };
    },
    resolveConflict: async (root, title, choice) => {
      window.__calls.push(["resolve", title, choice]);
      return { ok: true, text: choice === "disk" ? ${JSON.stringify(THEIRS)} : ${JSON.stringify(MINE)} };
    },
    reloadChapter: async (root, title) => {
      window.__calls.push(["reload", title]);
      return { ok: true, text: ${JSON.stringify(THEIRS)} };
    },
    listAgents: async () => [], addAgent: async () => ({}), removeAgent: async () => true,
    probeAgent: async () => ({ ok: true }), enqueue: async () => true, manifest: async () => [],
    send: async () => [], collect: async () => ({ proposals: [], comments: [] }),
    runs: async () => [], commit: async () => ({ ok: true, text: "" }),
    ledger: async () => [], reply: async () => "",
    revertEdit: async (t) => t, revertAll: async (t) => t, describeEdits: async () => "",
    systemFonts: async () => [], openProjectUrl: async () => true,
    files: {
      scan: async () => ({ ok: true, count: 0 }), page: async () => ({ ok: true, entries: [], total: 0 }),
      search: async () => ({ ok: true, hits: [] }), sort: async () => ({ ok: true }),
      trash: async () => ({ ok: true, outcomes: [] }), trashViaHome: async () => ({ ok: true, path: "" }),
    },
  });
`);

await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(700);

const failures: string[] = [];

// A chapter has to be open before there is a manuscript. The welcome screen's
// primary action opens the seeded workspace; clicked through `evaluate` because
// Playwright's visibility check trips on the entrance animation.
await page.evaluate(() => document.querySelector<HTMLElement>(".actions .primary")?.click());
await page.waitForTimeout(700);

if ((await page.locator(".manuscript > p").count()) === 0) {
  console.error("  no chapter open — the fixture never reached the manuscript");
  process.exit(1);
}

// Type the way a person does, so the editor's own input path runs and the
// document becomes dirty. Synthesising an `input` event skipped that.
await page.locator(".manuscript > p").first().click();
await page.keyboard.press("End");
await page.keyboard.type("追加的一句。");
await page.waitForTimeout(300);
await page.keyboard.press("Control+s");
await page.keyboard.type(DURING_SAVE);
await page.waitForTimeout(700);

const dialog = page.locator(".conflict");
if ((await dialog.count()) === 0) {
  const calls = await page.evaluate("JSON.stringify(window.__calls)");
  failures.push(
    `a refused save raised no dialog — the author would see nothing happen. calls: ${calls}`,
  );
} else {
  const shown = (await dialog.first().innerText()).replace(/\s+/g, "");
  // Both versions, or the choice is not a choice.
  if (!shown.includes("我这边写的一句"))
    failures.push("the dialog does not show this session's text");
  if (!shown.includes("别处改写过的一句"))
    failures.push("the dialog does not show the file's text");
  const focusInside = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && document.querySelector(".conflict")?.contains(active);
  });
  if (!focusInside) failures.push("the conflict dialog did not take keyboard focus");

  // One action per version, each under the version it keeps. A reversed
  // mapping on an irreversible choice loses work to muscle memory.
  const choices = page.locator(".versions .choose");
  if ((await choices.count()) !== 2)
    failures.push(`expected one action per version, found ${await choices.count()}`);

  const order: string[] = JSON.parse(
    await page.evaluate(
      `JSON.stringify([...document.querySelectorAll('.versions section')].map(s => s.querySelector('.label').textContent.trim()))`,
    ),
  );
  if (!order[0]?.includes("我这边")) failures.push(`left pane is ${order[0]}, expected mine`);

  // Distinct labels. Identical ones ("Keep this one" twice) are ambiguous the
  // moment position is gone — under a screen reader, in keyboard focus, or in
  // the memory of what you just pressed.
  const labels: string[] = JSON.parse(
    await page.evaluate(
      `JSON.stringify([...document.querySelectorAll('.versions .choose')].map(b => b.textContent.trim()))`,
    ),
  );
  if (labels[0] === labels[1]) failures.push(`both choices read "${labels[0]}"`);

  // The cost belongs above the button, or the eye reaches the action before the
  // consequence.
  const costAbove = await page.evaluate(
    `(() => {
       const s = document.querySelector('.versions section');
       const cost = s.querySelector('.cost').getBoundingClientRect();
       const button = s.querySelector('.choose').getBoundingClientRect();
       return cost.top < button.top;
     })()`,
  );
  if (costAbove !== true) failures.push("the cost is printed below the button it applies to");

  // A filled button, not a coloured word: an irreversible choice needs a hit
  // area a hand can aim at.
  const filled = await page.evaluate(
    "getComputedStyle(document.querySelector('.versions .choose')).backgroundColor",
  );
  if (filled === "rgba(0, 0, 0, 0)")
    failures.push("the choice renders as text rather than a button");

  // And a way out that decides nothing.
  if ((await page.locator(".conflict-actions .quiet").count()) !== 1)
    failures.push("no way to leave the question open");

  // Nothing may have been written yet beyond the save that was refused.
  const calls: [string, ...string[]][] = JSON.parse(
    await page.evaluate("JSON.stringify(window.__calls)"),
  );
  if (calls.some(([kind]) => kind === "reload"))
    failures.push("the dialog reloaded before the author chose");

  await page.screenshot({ path: join(root, "shots", "conflict.png") });

  // Text entered while save was waiting was never part of the displayed local
  // version. The first click may refresh the choice, but cannot discard text the
  // author had not yet seen in the dialog.
  await page.locator(".versions section:nth-child(2) .choose").click();
  await page.waitForTimeout(500);
  if ((await page.locator(".conflict").count()) !== 1)
    throw new Error("an old conflict choice discarded text entered while save was waiting");
  const refreshed = (await page.locator(".conflict").innerText()).replace(/\s+/g, "");
  if (!refreshed.includes(DURING_SAVE))
    failures.push("the refreshed local version omits text entered while save was waiting");
  const stillLocal = (await page.locator(".manuscript").innerText()).replace(/\s+/g, "");
  if (!stillLocal.includes(DURING_SAVE))
    failures.push("refreshing the conflict erased text entered while save was waiting");
  const afterRefresh: [string, ...string[]][] = JSON.parse(
    await page.evaluate("JSON.stringify(window.__calls)"),
  );
  if (afterRefresh.some(([kind]) => kind === "resolve"))
    failures.push("the stale choice reached conflict resolution before showing the latest text");

  // Taking the file's version now replaces the surface: the refreshed dialog
  // has shown every local character that this choice will discard.
  await page.locator(".versions section:nth-child(2) .choose").click();
  await page.waitForTimeout(400);
  if ((await page.locator(".conflict").count()) !== 0)
    failures.push("the dialog stayed open after a choice");
  const surface = (await page.locator(".manuscript").innerText()).replace(/\s+/g, "");
  if (!surface.includes("别处改写过的一句"))
    failures.push("taking the file's version did not reach the editor");

  const afterChoice: [string, ...string[]][] = JSON.parse(
    await page.evaluate("JSON.stringify(window.__calls)"),
  );
  if (!afterChoice.some(([kind, , choice]) => kind === "resolve" && choice === "disk"))
    failures.push("taking the file did not use the atomic conflict-resolution channel");
  if (afterChoice.some(([kind]) => kind === "reload"))
    failures.push("taking the file used the obsolete reload-then-save path");
  if (afterChoice.filter(([kind]) => kind === "save").length !== 2)
    failures.push("the latest local version was not rechecked exactly once before resolution");
}

await browser.close();
server.stop();

if (failures.length > 0) {
  for (const line of failures) console.error(`  ${line}`);
  console.error(`FAIL  ${failures.length} problem(s) with the outside-edit dialog`);
  process.exit(1);
}

console.log("PASS  an outside edit raises a dialog showing both versions, and neither wins alone");
