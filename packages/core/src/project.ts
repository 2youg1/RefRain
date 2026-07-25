import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { TextHead } from "./domain.ts";

/**
 * Axiom 1: files are truth. A chapter is a Markdown file a reader can open,
 * edit, and track in git without this application ever running.
 */

export interface Chapter {
  readonly title: string;
  readonly path: string;
  readonly head: TextHead;
}

export interface Project {
  readonly root: string;
  readonly chapters: readonly Chapter[];
}

const BLOCK_SEPARATOR = /\n\s*\n/;

/**
 * Block identity is derived from position, so a reload of unchanged text yields
 * the same identifiers and queued proposals still resolve. Editing renumbers
 * from the edit onward, which is exactly when a proposal should be flagged as
 * drifted rather than silently reattached.
 */
const parseChapter = (title: string, path: string, markdown: string): Chapter => ({
  title,
  path,
  head: {
    id: `${title}@load`,
    blocks: markdown
      .split(BLOCK_SEPARATOR)
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text, index) => ({ id: `${title}:b${index}`, text })),
    cause: "loaded from disk",
  },
});

export const loadProject = (root: string): Project => ({
  root,
  chapters: readdirSync(root)
    .filter((name) => extname(name) === ".md")
    .sort()
    .map((name) => {
      const path = join(root, name);
      return parseChapter(basename(name, ".md"), path, readFileSync(path, "utf8"));
    }),
});

export const serializeChapter = (head: TextHead): string =>
  `${head.blocks.map((b) => b.text).join("\n\n")}\n`;

/**
 * Written through a temp file and renamed, so a crash mid-write leaves the
 * previous chapter intact rather than a truncated one. The manuscript is the
 * one thing this application must never damage.
 */
export const saveChapter = (project: Project, title: string, head: TextHead): void => {
  const chapter = project.chapters.find((c) => c.title === title);
  const path = chapter?.path ?? join(project.root, `${title}.md`);
  const temporary = `${path}.writing`;

  writeFileSync(temporary, serializeChapter(head), "utf8");
  renameSync(temporary, path);
};
