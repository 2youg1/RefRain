import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspace } from "../src/project.ts";

/**
 * Roots, and what a workspace collects from them (SPEC Q11).
 *
 * Two defects taught this file what to assert. Opening a single file left an
 * empty interface: the chapter was filed under the file's *parent directory*
 * while the root recorded was the file itself, so the rail — which filters
 * chapters by their root — matched nothing and showed a workspace with no
 * chapters in it. And a folder was read one level deep, so Markdown in a
 * subdirectory appeared in the file browser, could not be opened, and had no
 * name for what it was.
 *
 * SPEC Q11 settles the second: material is the default role and a chapter is a
 * promotion. A chronology filed as a chapter corrupts numbering, the progress
 * rule, and the send manifest.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), "refrain-roots-"));

test("a single file opened on its own belongs to itself, not to its folder", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "one.md"), "第一段。\n\n第二段。", "utf8");
    writeFileSync(join(dir, "two.md"), "邻居，未被收养。", "utf8");

    const file = join(dir, "one.md");
    const workspace = loadWorkspace([file]);
    const root = workspace.roots[0];
    const chapter = workspace.chapters[0];

    expect(workspace.chapters).toHaveLength(1);
    // The defect: chapter.rootId pointed at `dir` while the root was `file`,
    // so every rail lookup by root came back empty.
    expect(chapter?.rootId).toBe(root?.id as string);
    expect(root?.kind).toBe("file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder root collects Markdown from its subdirectories too", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "01.md"), "开篇。", "utf8");
    mkdirSync(join(dir, "资料"), { recursive: true });
    writeFileSync(join(dir, "资料", "年表.md"), "一九〇五年。", "utf8");

    const found = loadWorkspace([dir]).chapters.map((c) => c.id);

    // It appeared in the file browser and could not be opened: the browser
    // walks the tree natively, the workspace read one level.
    expect(found).toContain("资料/年表.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Markdown in a subdirectory is material; the top level is chapters", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "01.md"), "第一章。", "utf8");
    writeFileSync(join(dir, "02.md"), "第二章。", "utf8");
    mkdirSync(join(dir, "资料"), { recursive: true });
    writeFileSync(join(dir, "资料", "年表.md"), "一九〇五年。", "utf8");
    writeFileSync(join(dir, "资料", "书目.md"), "参考文献。", "utf8");

    const workspace = loadWorkspace([dir]);
    const role = (id: string) => workspace.chapters.find((c) => c.id === id)?.role;

    expect(role("01.md")).toBe("chapter");
    expect(role("02.md")).toBe("chapter");
    expect(role("资料/年表.md")).toBe("material");
    expect(role("资料/书目.md")).toBe("material");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lone file is a chapter, since it is the thing the writer opened", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "essay.md"), "正文。", "utf8");
    expect(loadWorkspace([join(dir, "essay.md")]).chapters[0]?.role).toBe("chapter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two roots keep their own chapters, even under the same names", () => {
  const a = scratch();
  const b = scratch();
  try {
    writeFileSync(join(a, "01.md"), "甲的第一章。", "utf8");
    writeFileSync(join(b, "01.md"), "乙的第一章。", "utf8");

    const workspace = loadWorkspace([a, b]);
    const ids = new Set(workspace.roots.map((r) => r.id));

    expect(workspace.chapters).toHaveLength(2);
    expect(ids.size).toBe(2);
    // Identity, not spelling: two roots may hold the same title, and a rail
    // that grouped by title would merge them.
    for (const chapter of workspace.chapters) expect(ids.has(chapter.rootId)).toBe(true);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("numbered chapters sort by their number rather than character order", () => {
  const dir = scratch();
  try {
    for (const name of ["chapter-10.md", "chapter-2.md", "chapter-1.md"])
      writeFileSync(join(dir, name), name, "utf8");

    expect(loadWorkspace([dir]).chapters.map((chapter) => chapter.id)).toEqual([
      "chapter-1.md",
      "chapter-2.md",
      "chapter-10.md",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the source backup is not collected, whatever it holds", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "01.md"), "正文。", "utf8");
    mkdirSync(join(dir, ".refrain-source"), { recursive: true });
    writeFileSync(join(dir, ".refrain-source", "01.md"), "原件，永不写入。", "utf8");
    mkdirSync(join(dir, ".refrain"), { recursive: true });
    writeFileSync(join(dir, ".refrain", "notes.md"), "运行状态，不是稿件。", "utf8");

    const ids = loadWorkspace([dir]).chapters.map((c) => c.id);

    expect(ids).toEqual(["01.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one unreadable root does not take the rest of the workspace down", () => {
  const good = scratch();
  try {
    writeFileSync(join(good, "01.md"), "正文。", "utf8");
    const workspace = loadWorkspace([join(good, "nowhere-at-all"), good]);

    expect(workspace.chapters.map((c) => c.id)).toEqual(["01.md"]);
    expect(workspace.roots).toHaveLength(2);
    expect(workspace.roots.find((r) => r.missing)).toBeDefined();
  } finally {
    rmSync(good, { recursive: true, force: true });
  }
});
