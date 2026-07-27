/**
 * Composition, and the whitespace an author can see.
 *
 * Typing Chinese goes through an input method: what is on screen mid-word is a
 * candidate, not text. Nothing in the renderer knew that — there was not one
 * mention of `composition` anywhere in it. Two consequences, both silent:
 * Ctrl+S mid-composition wrote the half-formed pinyin to disk as prose, and a
 * `render()` arriving during composition replaced the surface out from under
 * the input method, dropping the candidate and moving the caret.
 *
 * This drives real `CompositionEvent`s against the built renderer. It cannot
 * stand in for the Windows IME gate, which types through `SendInput` against
 * Microsoft Pinyin and is the only evidence about a real input method — it
 * asserts the far narrower thing that the application now listens at all, and
 * that a save asked for mid-composition is deferred rather than lost.
 *
 * It also asserts what a Chinese author sees: an ideographic indent rendered
 * as an indent. The surface collapsed whitespace, so a paragraph that opens
 * with 　　 looked identical to one that does not, and the writer could not
 * see their own file.
 *
 * Injection proof that this gate bites: delete `if (composing) return;` from
 * `onEdit`, and the deferred-save assertion fails; remove `white-space:
 * pre-wrap` from `.manuscript > p`, and the indent assertion fails.
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

/** Every save is recorded with its text, so a premature one is visible. */
const bridge = `
window.__saves = [];
${BRIDGE_STUB}
Object.assign(window.refrain, {
  openProject: async () => "/work",
  openFile: async () => null,
  createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  loadProject: async () => [],
  saveChapter: async (root, id, text) => { window.__saves.push(text); return { ok: true, edits: [] }; },
  loadWorkspace: async (roots) => {
    const p = roots[0]; const id = "r-work";
    return { roots: [{ id, path: p, name: "work", kind: "folder" }],
      chapters: [{ id: "01.md", title: "01", text: "　　全角空格缩进的段落。\\n\\n第二段。",
        rootId: id, root: p, role: "chapter", path: p + "/01.md" }] };
  },
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {}, fonts: async () => [],
});`;

const failures: string[] = [];
// Windows runners cold-start this browser well past Playwright's 180 s default,
// which failed a release as a launch timeout rather than as anything about the
// application. The wait is generous because a slow machine is not a defect; a
// browser that never starts still fails, and says so.
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
await page.waitForTimeout(700);

const surface = await page.$(".manuscript");
if (surface === null) {
  failures.push("the manuscript surface never rendered, so nothing below was tested");
} else {
  // 1. The author's indent is visible as an indent, not collapsed to nothing.
  const indent = await page.evaluate(() => {
    const first = document.querySelector<HTMLElement>(".manuscript > p");
    if (first === null) return null;
    return {
      text: first.textContent ?? "",
      whiteSpace: getComputedStyle(first).whiteSpace,
      width: first.getBoundingClientRect().width,
    };
  });

  if (indent === null) failures.push("the manuscript rendered no paragraphs");
  else {
    if (!indent.text.startsWith("　　"))
      failures.push(
        `the ideographic indent was stripped before it reached the surface: ${JSON.stringify(indent.text.slice(0, 12))}`,
      );
    if (!/^pre/.test(indent.whiteSpace))
      failures.push(
        `the surface collapses whitespace (white-space: ${indent.whiteSpace}), so an author cannot see their own indent`,
      );
  }

  // 2. A composition in progress is not read back as the manuscript, and a
  //    save asked for during it is deferred rather than writing a candidate.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".manuscript");
    const first = el?.querySelector("p");
    if (!el || !first) return;
    el.focus();
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    first.textContent = `${first.textContent}nihao`;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });

  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);

  const during = await page.evaluate(() => (window as never as { __saves: string[] }).__saves);
  if (during.length > 0)
    failures.push(
      `a save during composition wrote the candidate to disk: ${JSON.stringify(during[0]?.slice(0, 40))}`,
    );

  // 3. Committing the composition performs the save that was waiting.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".manuscript");
    const first = el?.querySelector("p");
    if (!el || !first) return;
    first.textContent = (first.textContent ?? "").replace("nihao", "你好");
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
  });
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => (window as never as { __saves: string[] }).__saves);
  if (after.length === 0)
    failures.push("the save deferred by composition never happened, so the author lost it");
  else {
    const written = after[after.length - 1] ?? "";
    if (written.includes("nihao"))
      failures.push(
        `the uncommitted candidate reached disk: ${JSON.stringify(written.slice(0, 40))}`,
      );
    if (!written.includes("你好"))
      failures.push(
        `the committed text did not reach the save: ${JSON.stringify(written.slice(0, 40))}`,
      );
    if (!written.startsWith("　　"))
      failures.push(
        `the indent was lost on the way to disk: ${JSON.stringify(written.slice(0, 12))}`,
      );
  }
}

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error("composition and whitespace: the surface does not keep its promises\n");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log("PASS  composition defers the save, and the author's indent is visible and preserved");
