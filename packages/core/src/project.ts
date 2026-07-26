import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { TextHead } from "./domain.ts";

/**
 * Axiom 1: files are truth. A chapter is a Markdown file a reader can open,
 * edit, and track in git without this application ever running.
 *
 * A workspace holds several roots rather than one. Binding the application to a
 * single folder forced a choice nobody should have to make: either keep an
 * empty folder for tidiness and lose access to the actual manuscripts, or open
 * the manuscripts and have every file in that tree declared part of the work.
 * Roots are added and removed; a single file can be opened without adopting its
 * neighbours.
 */

export interface Chapter {
  readonly title: string;
  readonly path: string;
  readonly root: string;
  readonly head: TextHead;
}

export interface Root {
  readonly path: string;
  readonly name: string;
  /** A single file opened on its own, not a folder whose contents were adopted. */
  readonly single: boolean;
}

export interface Workspace {
  readonly roots: readonly Root[];
  readonly chapters: readonly Chapter[];
}

const BLOCK_SEPARATOR = /\n\s*\n/;
const MARKDOWN = new Set([".md", ".markdown", ".mdown", ".txt"]);

/**
 * Block identity is derived from position, so a reload of unchanged text yields
 * the same identifiers and queued proposals still resolve. Editing renumbers
 * from the edit onward, which is exactly when a proposal should be flagged as
 * drifted rather than silently reattached.
 */
const parseChapter = (root: string, path: string, markdown: string): Chapter => {
  const title = basename(path, extname(path));
  return {
    title,
    path,
    root,
    head: {
      id: `${path}@load`,
      blocks: markdown
        .split(BLOCK_SEPARATOR)
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .map((text, index) => ({ id: `${title}:b${index}`, text })),
      cause: "loaded from disk",
    },
  };
};

const chaptersUnder = (root: Root): Chapter[] => {
  if (root.single) {
    return existsSync(root.path)
      ? [parseChapter(dirname(root.path), root.path, readFileSync(root.path, "utf8"))]
      : [];
  }

  if (!existsSync(root.path)) return [];
  return readdirSync(root.path)
    .filter((name) => MARKDOWN.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => {
      const path = join(root.path, name);
      return parseChapter(root.path, path, readFileSync(path, "utf8"));
    });
};

export const describeRoot = (path: string): Root => {
  const single = existsSync(path) && statSync(path).isFile();
  return { path, name: single ? basename(path) : basename(path) || path, single };
};

export const loadWorkspace = (paths: readonly string[]): Workspace => {
  const roots = paths.map(describeRoot);
  return { roots, chapters: roots.flatMap(chaptersUnder) };
};

/** Backwards-compatible single-root load, kept because tests and the L0 channel use it. */
export const loadProject = (root: string): { root: string; chapters: readonly Chapter[] } => ({
  root,
  chapters: chaptersUnder({ path: root, name: basename(root), single: false }),
});

export const serializeChapter = (head: TextHead): string =>
  `${head.blocks.map((b) => b.text).join("\n\n")}\n`;

/**
 * Written through a temp file and renamed, so a crash mid-write leaves the
 * previous chapter intact rather than a truncated one. The manuscript is the
 * one thing this application must never damage.
 */
export const writeChapter = (path: string, head: TextHead): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.writing`;
  writeFileSync(temporary, serializeChapter(head), "utf8");
  renameSync(temporary, path);
};

export const saveChapter = (
  project: { root: string; chapters: readonly Chapter[] },
  title: string,
  head: TextHead,
): void => {
  const chapter = project.chapters.find((c) => c.title === title);
  writeChapter(chapter?.path ?? join(project.root, `${title}.md`), head);
};
