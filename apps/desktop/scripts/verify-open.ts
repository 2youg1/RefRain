/**
 * Open a single file, and a folder with material in it, through the interface.
 *
 * The unit tests assert the workspace model. This asserts the thing the writer
 * reported: opening a file showed nothing. The chapter was filed under the
 * file's parent directory while the root recorded was the file itself, and the
 * rail — which grouped by comparing those two paths — matched nothing and drew
 * an empty workspace. No test failed, because no test opened a file.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";

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

const LONE = "一个人打开一份稿子，它就应当出现在眼前。";
const CHAPTER = "第一章的正文。";
const MATERIAL = "一九〇五年，年表里的一行。";

/**
 * The bridge answers as the real main process does: a single file is its own
 * root and its chapter belongs to it; a folder's subdirectory is material.
 *
 * `root` deliberately carries the *parent folder* for a lone file, because that
 * is what `parseChapter` recorded and what made the defect: the rail compared
 * `chapter.root` against the root's path, those two differed, and nothing
 * matched. A stub that set them equal would let the old code pass.
 */
const bridge = `window.refrain = {
  openProject: async () => "/work",
  openFile: async () => "/elsewhere/essay.md",
  createProject: async () => null,
  pathFor: () => "",
  resolveDrop: async () => null,
  fullscreen: async () => true,
  saveChapter: async () => ({ ok: true, edits: [] }),
  loadProject: async () => [],
  loadWorkspace: async (roots) => {
    const out = { roots: [], chapters: [] };
    for (const path of roots) {
      const file = path.endsWith(".md");
      const id = "r-" + path.replace(/[^a-z0-9]/gi, "");
      out.roots.push({ id, path, name: path.split("/").pop(), kind: file ? "file" : "folder" });
      if (file) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        out.chapters.push({ id: "essay.md", title: "essay", text: ${JSON.stringify(LONE)},
          rootId: id, root: parent, role: "chapter", path });
      } else {
        out.chapters.push({ id: "01.md", title: "01", text: ${JSON.stringify(CHAPTER)},
          rootId: id, root: path, role: "chapter", path: path + "/01.md" });
        out.chapters.push({ id: "资料/年表.md", title: "年表", text: ${JSON.stringify(MATERIAL)},
          rootId: id, root: path, role: "material", path: path + "/资料/年表.md" });
      }
    }
    return out;
  },
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChanged: () => {}, fonts: async () => [],
};`;

const failures: string[] = [];
const browser = await launchBrowser();

// ── A single file opened on its own ──────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.addInitScript(bridge);
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const open = [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
      /打开单个文件|Open a file/.test(b.textContent ?? ""),
    );
    open?.click();
  });
  await page.waitForTimeout(700);

  const state = await page.evaluate(() => ({
    surface: document.querySelector(".manuscript")?.textContent?.trim() ?? "",
    railChapters: document.querySelectorAll(".rail .chapter").length,
    railNames: [...document.querySelectorAll(".rail .chapter")].map((n) => n.textContent?.trim()),
  }));

  if (state.railChapters === 0)
    failures.push("a file opened on its own shows no chapter in the rail");
  if (!state.surface.includes(LONE))
    failures.push(`the opened file's text never reached the page: ${state.surface.slice(0, 40)}`);
  console.log(`  lone file  rail=${state.railChapters} ${JSON.stringify(state.railNames)}`);
  await page.close();
}

// ── A folder whose subdirectory holds material (SPEC Q11) ────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.addInitScript(bridge);
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const open = [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
      /打开文件夹|Open folder/.test(b.textContent ?? ""),
    );
    open?.click();
  });
  await page.waitForTimeout(700);

  const before = await page.evaluate(() => ({
    chapters: [...document.querySelectorAll(".rail .chapter:not(.material)")].map((n) =>
      n.textContent?.trim(),
    ),
    materialShown: document.querySelectorAll(".rail .chapter.material").length,
    hasFold: !!document.querySelector(".rail .material-head"),
  }));

  if (!before.chapters.includes("01")) failures.push("the top-level chapter is missing");
  if (before.chapters.includes("年表"))
    failures.push("material was filed into the chapter sequence, which corrupts its numbering");
  if (!before.hasFold) failures.push("material has no disclosure to open");
  if (before.materialShown !== 0) failures.push("material is expanded before it is asked for");

  await page.evaluate(() => document.querySelector<HTMLElement>(".rail .material-head")?.click());
  await page.waitForTimeout(250);

  const opened = await page.evaluate(
    () => document.querySelectorAll(".rail .chapter.material").length,
  );
  if (opened === 0) failures.push("opening the material disclosure revealed nothing");

  // The point of collecting it at all: it has to open in the editor.
  await page.evaluate(() =>
    document.querySelector<HTMLElement>(".rail .chapter.material")?.click(),
  );
  await page.waitForTimeout(400);
  const surface = await page.evaluate(
    () => document.querySelector(".manuscript")?.textContent?.trim() ?? "",
  );
  if (!surface.includes(MATERIAL))
    failures.push(`material would not open in the editor: ${surface.slice(0, 40)}`);

  console.log(`  folder     chapters=${JSON.stringify(before.chapters)} material=${opened}`);
  await page.close();
}

await browser.close();
server.stop();

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL  ${line}`);
  process.exit(1);
}

console.log("PASS  a lone file opens into the editor, and material is kept out of the sequence");
