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

/**
 * What a file looked like when this application last agreed with it.
 *
 * Size as well as mtime: a filesystem with one-second mtime granularity — and
 * several still have it — cannot distinguish two edits inside the same second,
 * but it can hardly ever produce the same byte count as well.
 */
export interface FileStamp {
  readonly modifiedMs: number;
  readonly bytes: number;
}

export const stampOf = (path: string): FileStamp | undefined => {
  try {
    const info = statSync(path);
    return { modifiedMs: info.mtimeMs, bytes: info.size };
  } catch {
    return undefined;
  }
};

export interface Chapter {
  readonly title: string;
  readonly path: string;
  readonly root: string;
  readonly head: TextHead;
  /**
   * What the file looked like when it was read.
   *
   * Carried so a later save can tell whether anyone else wrote to it in the
   * meantime. Absent only for a chapter that does not exist on disk yet.
   */
  readonly stamp?: FileStamp;
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
  const stamp = stampOf(path);
  return {
    title,
    path,
    root,
    ...(stamp === undefined ? {} : { stamp }),
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

/** A refusal, not an exception: the caller has to ask a person what to do. */
export interface ChangedUnderneath {
  readonly ok: false;
  readonly reason: "changed-underneath";
  readonly path: string;
  /** What is on disk right now, so the interface can offer to show it. */
  readonly onDisk: string;
}

export type WriteOutcome = { readonly ok: true; readonly stamp: FileStamp } | ChangedUnderneath;

/**
 * Write a chapter, unless someone else wrote it first.
 *
 * Two separate promises. The temp-file-and-rename keeps a crash mid-write from
 * leaving a truncated chapter — that was already here. What is new is the
 * comparison against `expected`: without it, a file edited in another editor
 * was silently overwritten on the next save, because this application's own
 * cached head was treated as the truth about the disk. The file is the truth
 * (SPEC axiom 1), and a caller that has not looked recently must be told so
 * rather than allowed to win.
 *
 * Passing no `expected` writes unconditionally, which is correct for a file
 * this application is creating.
 */
export const writeChapter = (path: string, head: TextHead, expected?: FileStamp): WriteOutcome => {
  if (expected !== undefined) {
    const actual = stampOf(path);
    // A file that has since vanished is not a conflict — the author moved or
    // deleted it, and writing it back is what they asked for by saving.
    if (
      actual !== undefined &&
      (actual.modifiedMs !== expected.modifiedMs || actual.bytes !== expected.bytes)
    )
      return {
        ok: false,
        reason: "changed-underneath",
        path,
        onDisk: readFileSync(path, "utf8"),
      };
  }

  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.writing`;
  writeFileSync(temporary, serializeChapter(head), "utf8");
  renameSync(temporary, path);
  return { ok: true, stamp: stampOf(path) ?? { modifiedMs: Date.now(), bytes: 0 } };
};

export const saveChapter = (
  project: { root: string; chapters: readonly Chapter[] },
  title: string,
  head: TextHead,
  expected?: FileStamp,
): WriteOutcome => {
  const chapter = project.chapters.find((c) => c.title === title);
  return writeChapter(chapter?.path ?? join(project.root, `${title}.md`), head, expected);
};
