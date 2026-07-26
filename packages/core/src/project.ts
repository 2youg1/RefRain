import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { replaceFileAtomically } from "./atomic-file.ts";
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
 * The digest decides identity. Size and mtime remain because they explain what
 * changed, but neither can prove equality: an editor can preserve both while
 * replacing every byte.
 */
export interface FileStamp {
  readonly modifiedMs: number;
  readonly bytes: number;
  readonly digest: string;
}

export interface ChapterFileSnapshot {
  readonly text: string;
  readonly stamp: FileStamp;
}

export const readChapterFile = (path: string): ChapterFileSnapshot | undefined => {
  let file: number;
  try {
    file = openSync(path, "r");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }

  try {
    const bytes = readFileSync(file);
    const info = fstatSync(file);
    return {
      text: bytes.toString("utf8"),
      stamp: {
        modifiedMs: info.mtimeMs,
        bytes: bytes.byteLength,
        digest: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } finally {
    closeSync(file);
  }
};

export const stampOf = (path: string): FileStamp | undefined => readChapterFile(path)?.stamp;

export interface Chapter {
  /** Portable identity inside the Root, including the extension. */
  readonly id: string;
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
const ILLEGAL_CHAPTER_CHARACTER = /[<>:"/\\|?*]/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SOURCE_BACKUP_DIR = ".refrain-source";

const namesSourceBackup = (path: string): boolean =>
  path.split(/[/\\]+/).some((part) => part.toLowerCase() === SOURCE_BACKUP_DIR);

/** Source Backup has no write path, even when opened directly or reached through a symlink. */
const assertMutableChapterPath = (path: string): void => {
  let parent = dirname(path);
  try {
    parent = realpathSync(parent);
  } catch {
    // A new directory has no resolved form yet; its literal path still carries
    // enough information to refuse a Source Backup component.
  }
  if (namesSourceBackup(path) || namesSourceBackup(parent))
    throw new Error(`Source Backup is never written to: ${path}`);
};

const pathForNewChapter = (root: string, title: string): string => {
  if (
    title.length === 0 ||
    title.includes("\0") ||
    ILLEGAL_CHAPTER_CHARACTER.test(title) ||
    title.endsWith(".") ||
    title.endsWith(" ") ||
    WINDOWS_DEVICE.test(title)
  )
    throw new Error(`invalid chapter title: ${title}`);
  return join(root, `${title}.md`);
};

/**
 * Block identity is derived from position, so a reload of unchanged text yields
 * the same identifiers and queued proposals still resolve. Editing renumbers
 * from the edit onward, which is exactly when a proposal should be flagged as
 * drifted rather than silently reattached.
 */
const parseChapter = (root: string, path: string, snapshot: ChapterFileSnapshot): Chapter => {
  const title = basename(path, extname(path));
  const id = relative(root, path)
    .split(/[/\\]+/)
    .join("/");
  return {
    id,
    title,
    path,
    root,
    stamp: snapshot.stamp,
    head: {
      id: `${path}@load`,
      blocks: snapshot.text
        .split(BLOCK_SEPARATOR)
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .map((text, index) => ({ id: `${id}:b${index}`, text })),
      cause: "loaded from disk",
    },
  };
};

const chaptersUnder = (root: Root): Chapter[] => {
  if (root.single) {
    const snapshot = readChapterFile(root.path);
    return snapshot === undefined ? [] : [parseChapter(dirname(root.path), root.path, snapshot)];
  }

  if (!existsSync(root.path)) return [];
  return readdirSync(root.path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MARKDOWN.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const path = join(root.path, name);
      const snapshot = readChapterFile(path);
      return snapshot === undefined ? [] : [parseChapter(root.path, path, snapshot)];
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
  /** The exact disk version shown to the author; conflict resolution is a CAS against it. */
  readonly stamp: FileStamp;
}

export type WriteOutcome =
  | { readonly ok: true; readonly path: string; readonly stamp: FileStamp }
  | ChangedUnderneath;

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
  assertMutableChapterPath(path);
  if (expected !== undefined) {
    const actual = readChapterFile(path);
    // A file that has since vanished is not a conflict — the author moved or
    // deleted it, and writing it back is what they asked for by saving.
    if (actual !== undefined && actual.stamp.digest !== expected.digest)
      return {
        ok: false,
        reason: "changed-underneath",
        path,
        onDisk: actual.text,
        stamp: actual.stamp,
      };
  }

  replaceFileAtomically(path, serializeChapter(head));
  const stamp = stampOf(path);
  if (stamp === undefined) throw new Error(`chapter vanished after save: ${path}`);
  return { ok: true, path, stamp };
};

export const saveChapter = (
  project: { root: string; chapters: readonly Chapter[] },
  idOrTitle: string,
  head: TextHead,
  expected?: FileStamp,
): WriteOutcome => {
  const chapter = project.chapters.find(
    (candidate) => candidate.id === idOrTitle || candidate.title === idOrTitle,
  );
  const extension = extname(idOrTitle);
  const title =
    chapter === undefined && extension === ".md" && basename(idOrTitle) === idOrTitle
      ? basename(idOrTitle, extension)
      : idOrTitle;
  return writeChapter(chapter?.path ?? pathForNewChapter(project.root, title), head, expected);
};
