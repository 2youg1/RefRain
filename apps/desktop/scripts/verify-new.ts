/**
 * Create a chapter through the interface, at every entrance that offers it.
 *
 * `window.prompt` is disabled in Electron, and four ways of asking for a new
 * chapter — the rail button, the command palette, Ctrl+N, and the empty page —
 * all called it. So all four did nothing: no dialog, no chapter, no error. The
 * button was there and the application declined to react.
 *
 * This drives the real build and asserts a chapter arrives. It also asserts the
 * refusals, because a name field that accepts a duplicate writes over a chapter
 * that already exists.
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

/** The bridge keeps a growing workspace, so a created chapter can be seen. */
const bridge = `
window.__created = [];
${BRIDGE_STUB}
Object.assign(window.refrain, {
  openProject: async () => "/work",
  openFile: async () => null,
  createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  loadProject: async () => [],
  saveChapter: async (root, id) => { if (!window.__created.includes(id)) window.__created.push(id);
    return { ok: true, edits: [] }; },
  loadWorkspace: async (roots) => {
    const p = roots[0]; const id = "r-work";
    const made = window.__created.map((cid) => ({
      id: cid, title: cid.split("/").pop().replace(/\\.md$/, ""), text: "",
      rootId: id, root: p, role: cid.includes("/") ? "material" : "chapter", path: p + "/" + cid }));
    return { roots: [{ id, path: p, name: "work", kind: "folder" }],
      chapters: [{ id: "01.md", title: "01", text: "已有的一章。", rootId: id, root: p,
        role: "chapter", path: p + "/01.md" }, ...made] };
  },
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {}, fonts: async () => [],
});`;

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);

await page.evaluate(() => {
  [...document.querySelectorAll<HTMLElement>("button")]
    .find((b) => /打开文件夹|Open folder/.test(b.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(600);

const dialogOpen = (): Promise<boolean> =>
  page.evaluate(() => !!document.querySelector('[role="dialog"] input'));

// ── The rail button ─────────────────────────────────────────────
await page.evaluate(() => {
  [...document.querySelectorAll<HTMLElement>(".rail-foot button")]
    .find((b) => /新建章节|New chapter/.test(b.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(300);
if (!(await dialogOpen())) failures.push("the rail button asked nothing");

// The field must already hold focus: it is the only reason this is on screen.
const focused = await page.evaluate(
  () => document.activeElement === document.querySelector('[role="dialog"] input'),
);
if (!focused) failures.push("the name field does not take focus when it opens");

// A duplicate name must be refused rather thanoverwrite an existing chapter.
await page.fill('[role="dialog"] input', "01");
await page.waitForTimeout(200);
const onDuplicate = await page.evaluate(() => ({
  refused: !!document.querySelector('[role="dialog"] .refusal'),
  disabled: !!document.querySelector<HTMLButtonElement>('[role="dialog"] .primary')?.disabled,
}));
if (!onDuplicate.refused) failures.push("a duplicate name was accepted without a word");
if (!onDuplicate.disabled) failures.push("a duplicate name left the confirm button live");

// An illegal filename must be refused too.
await page.fill('[role="dialog"] input', "a/b");
await page.waitForTimeout(200);
if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"] .refusal'))))
  failures.push("a name containing a path separator was accepted");

// A good name creates the chapter and opens it.
await page.fill('[role="dialog"] input', "第三章 雨");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(700);

const afterCreate = await page.evaluate(() => ({
  created: (window as unknown as { __created: string[] }).__created,
  dialog: !!document.querySelector('[role="dialog"]'),
  rail: [...document.querySelectorAll(".rail .chapter:not(.material)")].map((n) =>
    n.textContent?.trim(),
  ),
}));
if (!afterCreate.created.includes("第三章 雨.md"))
  failures.push(`Enter did not create the chapter: ${JSON.stringify(afterCreate.created)}`);
if (afterCreate.dialog) failures.push("the dialog stayed open after creating");
if (!afterCreate.rail.includes("第三章 雨"))
  failures.push(`the new chapter is not in the rail: ${JSON.stringify(afterCreate.rail)}`);

// ── Escape closes this and nothing else ─────────────────────────
await page.evaluate(() => {
  [...document.querySelectorAll<HTMLElement>(".rail-foot button")]
    .find((b) => /新建章节|New chapter/.test(b.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(250);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
if (await dialogOpen()) failures.push("Escape did not close the name field");

// ── New material goes under its own folder (SPEC Q11) ───────────
// Through the command palette, which is where this command lives: the rail
// offers the chapter sequence, and material is deliberately not in it.
await page.click("body");
await page.keyboard.down("Control");
await page.keyboard.press("k");
await page.keyboard.up("Control");
await page.waitForTimeout(350);
await page.evaluate(() => {
  const entry = [...document.querySelectorAll<HTMLElement>("button, li, [role=option]")].find((n) =>
    /新建资料|New material/.test(n.textContent ?? ""),
  );
  entry?.click();
});
await page.waitForTimeout(350);

if (!(await dialogOpen())) failures.push("the new-material command asked nothing");
else {
  await page.fill('[role="dialog"] input', "年表");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const created = await page.evaluate(
    () => (window as unknown as { __created: string[] }).__created,
  );
  if (!created.some((id) => id.includes("/") && id.endsWith("年表.md")))
    failures.push(`material was not filed under a folder: ${JSON.stringify(created)}`);
  // Material must not join the chapter sequence, which is the whole of Q11.
  const inSequence = await page.evaluate(() =>
    [...document.querySelectorAll(".rail .chapter:not(.material)")].map((n) =>
      n.textContent?.trim(),
    ),
  );
  if (inSequence.includes("年表"))
    failures.push("new material was filed into the chapter sequence");
}

console.log(
  `  created ${JSON.stringify(await page.evaluate(() => (window as never as { __created: string[] }).__created))}`,
);

await browser.close();
server.stop();

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL  ${line}`);
  process.exit(1);
}

console.log("PASS  a new chapter is asked for, refused when it should be, and created");
