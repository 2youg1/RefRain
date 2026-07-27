import { createHash } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import {
  ownsInterruptedWrite,
  recoverInterruptedWrite,
  replaceFileAtomically,
} from "./atomic-file.ts";
import type { TextHead } from "./domain.ts";
import { storageForRoot } from "./root-storage.ts";
import { applyBlocks, blockPrefix, parseSource, splitBlocks } from "./roundtrip.ts";

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

/** What a file is to the work, which is not the same as where it sits. */
export type ChapterRole = "chapter" | "material";

export interface Chapter {
  /** Portable identity inside the Root, including the extension. */
  readonly id: string;
  readonly title: string;
  readonly path: string;
  /**
   * Which Root this belongs to, by identity rather than by path.
   *
   * A single file opened on its own used to record the file as the root and
   * file its chapter under the file's parent directory, so the rail — which
   * groups chapters by root — matched nothing and drew an empty workspace.
   * Comparing identifiers cannot go wrong that way, and it survives two roots
   * holding chapters of the same name.
   */
  readonly rootId: string;
  /**
   * Chapter or material (SPEC Q11). Material is the default for anything in a
   * subdirectory: notes, chronologies and sources are not part of the chapter
   * sequence, and filing them there corrupts numbering, the progress rule, and
   * the send manifest. A chapter is a promotion, not the starting role.
   */
  readonly role: ChapterRole;
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
  readonly id: string;
  readonly path: string;
  readonly name: string;
  /** A folder whose Markdown was adopted, or a single file opened on its own. */
  readonly kind: "folder" | "file";
  /** The path did not resolve. The other roots still open. */
  readonly missing?: boolean;
}

export interface Workspace {
  readonly roots: readonly Root[];
  readonly chapters: readonly Chapter[];
  /** Divergent `.writing` files preserved before any project writer opened. */
  readonly recoveryEvidencePaths: readonly string[];
  /** Residues that could not be recovered; healthy Roots still open. */
  readonly recoveryWarnings: readonly string[];
}

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

const isWithin = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
};

/** Resolve every existing component so a directory symlink cannot move a write outside its Root. */
const assertChapterInsideRoot = (root: string, path: string): void => {
  const canonicalRoot = realpathSync(root);
  if (statSync(canonicalRoot).isFile()) {
    if (!existsSync(path) || realpathSync(path) !== canonicalRoot)
      throw new Error(`manuscript path is outside its file Root: ${path}`);
    return;
  }

  let ancestor = dirname(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!isWithin(canonicalRoot, realpathSync(ancestor)))
    throw new Error(`manuscript path is outside Root ${root}: ${path}`);
  if (existsSync(path) && !isWithin(canonicalRoot, realpathSync(path)))
    throw new Error(`manuscript path resolves outside Root ${root}: ${path}`);
};

const isLegalSegment = (segment: string): boolean =>
  segment.length > 0 &&
  !segment.includes("\0") &&
  !ILLEGAL_CHAPTER_CHARACTER.test(segment) &&
  !segment.endsWith(".") &&
  !segment.endsWith(" ") &&
  !WINDOWS_DEVICE.test(segment);

/**
 * Where a new chapter goes, from a title or from a path inside the root.
 *
 * Material lives in a folder of its own, so the interface asks for
 * `资料/年表.md` — and every such request failed. The separator made
 * `basename(id) === id` false in the caller, the whole string arrived here as a
 * title, and the illegal-character set contains the very separator that sent it
 * down this branch. Creating material could not succeed at all, in either
 * language, whether or not the folder already existed.
 *
 * So a title may now be several segments. Each is checked on its own — the same
 * rules, applied where they mean something — and the parent is created. `..`
 * fails `isLegalSegment` by ending in a dot, which is what keeps a nested id
 * from climbing out of the root.
 */
const pathForNewChapter = (root: string, title: string): string => {
  const segments = title.split(/[/\\]+/);
  if (segments.length === 0 || !segments.every(isLegalSegment))
    throw new Error(`invalid chapter title: ${title}`);

  return join(root, `${segments.join("/")}.md`);
};

/**
 * Block identity is derived from position, so a reload of unchanged text yields
 * the same identifiers and queued proposals still resolve. Editing renumbers
 * from the edit onward, which is exactly when a proposal should be flagged as
 * drifted rather than silently reattached.
 */
const parseChapter = (
  root: Root,
  base: string,
  path: string,
  role: ChapterRole,
  snapshot: ChapterFileSnapshot,
): Chapter => {
  const title = basename(path, extname(path));
  const id = relative(base, path)
    .split(/[/\\]+/)
    .join("/");
  return {
    id,
    title,
    path,
    rootId: root.id,
    role,
    stamp: snapshot.stamp,
    head: {
      id: `${path}@load`,
      // No trim. An ideographic indent is how a Chinese paragraph begins, and
      // stripping it on load deleted the author's bytes before they had done
      // anything at all (SPEC INV-5).
      blocks: splitBlocks(snapshot.text).map((text, index) => ({ id: `${id}:b${index}`, text })),
      cause: "loaded from disk",
    },
  };
};

/** Neither the Source Backup nor the application's own state is manuscript. */
const RESERVED_DIR = new Set([SOURCE_BACKUP_DIR, ".refrain"]);

const isSourceBackupPath = (path: string): boolean => {
  if (namesSourceBackup(path)) return true;
  try {
    return namesSourceBackup(realpathSync(path));
  } catch {
    return false;
  }
};

interface RecoveryReport {
  readonly evidencePaths: string[];
  readonly warnings: string[];
}

const recoverOwnedTarget = (target: string, report: RecoveryReport): void => {
  try {
    const result = recoverInterruptedWrite(target);
    if (result.recoveryEvidencePath !== undefined)
      report.evidencePaths.push(result.recoveryEvidencePath);
  } catch (error) {
    report.warnings.push(`Could not recover interrupted write ${target}: ${String(error)}`);
  }
};

const STATE_TARGETS = ["host.json", "agents.json", "decision-commit.json"] as const;

const recoverRootState = (root: Root, report: RecoveryReport): void => {
  for (const name of STATE_TARGETS)
    recoverOwnedTarget(join(storageForRoot(root).stateDir, name), report);
};

const isManuscriptResidue = (name: string): boolean =>
  name.endsWith(".writing") && isMarkdown(name.slice(0, -".writing".length));

/** A chapter number is a number: 10 follows 9 rather than 1. */
const FILE_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const isMarkdown = (name: string): boolean => MARKDOWN.has(extname(name).toLowerCase());

/**
 * Walk a folder root, depth first, naming what each file is.
 *
 * Top level is the chapter sequence; everything below it is material (SPEC
 * Q11). Reading only the top level — which is what this did — left Markdown in
 * a subdirectory visible in the file browser, which walks the tree natively,
 * and unopenable in the editor, which did not.
 */
const collect = (
  root: Root,
  dir: string,
  depth: number,
  into: Chapter[],
  recovery?: RecoveryReport,
): void => {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable subdirectory is not a reason to lose the rest of the work.
    return;
  }

  // Numeric collation keeps chapter-2 before chapter-10 regardless of the
  // filesystem's enumeration order; the rail's sequence is the writer's sequence.
  for (const entry of [...entries].sort((a, b) => FILE_ORDER.compare(a.name, b.name))) {
    const name = entry.name;
    if (name.startsWith(".") && RESERVED_DIR.has(name.toLowerCase())) continue;
    const path = join(dir, name);

    if (entry.isDirectory()) {
      // Hidden tool trees may contain files named `.writing`, but RefRain did
      // not create them. They remain readable as material without granting the
      // recovery sweep ownership of their names.
      collect(root, path, depth + 1, into, name.startsWith(".") ? undefined : recovery);
      continue;
    }
    if (entry.isFile() && recovery !== undefined && isManuscriptResidue(name)) {
      const target = path.slice(0, -".writing".length);
      if (ownsInterruptedWrite(target)) recoverOwnedTarget(target, recovery);
      continue;
    }
    if (!entry.isFile() || !isMarkdown(name)) continue;

    const snapshot = readChapterFile(path);
    if (snapshot === undefined) continue;
    into.push(parseChapter(root, root.path, path, depth === 0 ? "chapter" : "material", snapshot));
  }
};

const chaptersUnder = (root: Root, recovery?: RecoveryReport): Chapter[] => {
  if (root.missing) return [];
  const canRecover = recovery !== undefined && !isSourceBackupPath(root.path);

  if (root.kind === "file") {
    if (canRecover) {
      recoverRootState(root, recovery);
      if (ownsInterruptedWrite(root.path)) recoverOwnedTarget(root.path, recovery);
    }
    const snapshot = readChapterFile(root.path);
    // A lone file is a chapter: it is the thing the writer opened. Its id is
    // taken against its own directory so it reads as a name rather than a path.
    return snapshot === undefined
      ? []
      : [parseChapter(root, dirname(root.path), root.path, "chapter", snapshot)];
  }

  if (canRecover) recoverRootState(root, recovery);
  const found: Chapter[] = [];
  collect(root, root.path, 0, found, canRecover ? recovery : undefined);
  return found;
};

/**
 * A Root's identity is its canonical path, hashed.
 *
 * Derived rather than random so it survives a restart: the rail, the queue and
 * the ledger all reference roots, and an identifier regenerated on each launch
 * would orphan every one of them. Canonical first, so the same folder reached
 * through a symlink or a trailing slash is one root and not two.
 */
const identify = (path: string): string => {
  let canonical = path;
  try {
    canonical = realpathSync(path);
  } catch {
    // A missing root still needs an identity — the interface has to name it.
  }
  return `r-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
};

export const describeRoot = (path: string): Root => {
  const exists = existsSync(path);
  const kind = exists && statSync(path).isFile() ? "file" : "folder";
  return {
    id: identify(path),
    path,
    name: basename(path) || path,
    kind,
    ...(exists ? {} : { missing: true }),
  };
};

/**
 * One bad root does not close the workspace.
 *
 * A folder that has been moved, unmounted, or renamed since it was last opened
 * used to take every other root down with it, so a writer with a chapter on a
 * detached drive could not reach the chapters on their own disk. A missing root
 * stays in the list, carrying `missing`, for the interface to explain.
 */
export const loadWorkspace = (paths: readonly string[]): Workspace => {
  const roots = paths.map(describeRoot);
  const recovery: RecoveryReport = { evidencePaths: [], warnings: [] };
  const chapters = roots.flatMap((root) => chaptersUnder(root, recovery));
  return {
    roots,
    chapters,
    recoveryEvidencePaths: recovery.evidencePaths,
    recoveryWarnings: recovery.warnings,
  };
};

/** Backwards-compatible single-root load, kept because tests and the L0 channel use it. */
export const loadProject = (root: string): { root: string; chapters: readonly Chapter[] } => ({
  root,
  chapters: chaptersUnder(describeRoot(root)),
});

/**
 * Rebuild a chapter's text from its blocks.
 *
 * Used when there is nothing on disk to compare against — a new chapter, or a
 * caller that never read the file. When the file does exist, `writeChapter`
 * goes through `applyBlocks` instead, which keeps the author's own blank lines
 * rather than normalising every gap to one (SPEC INV-5).
 */
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
  | {
      readonly ok: true;
      readonly path: string;
      readonly stamp: FileStamp;
      readonly recoveryEvidencePath?: string;
    }
  | ChangedUnderneath;

/** One exact byte plan shared by the decision intent and the canonical write. */
export interface PreparedChapterWrite {
  readonly ok: true;
  readonly path: string;
  readonly content: string;
  readonly expected?: FileStamp;
  readonly root?: string;
}

const changedSnapshot = (
  path: string,
  expected: FileStamp,
  actual: ChapterFileSnapshot | undefined,
): ChangedUnderneath | undefined => {
  // A file that has since vanished is not a conflict — the author moved or
  // deleted it, and writing it back is what they asked for by saving.
  return actual === undefined || actual.stamp.digest === expected.digest
    ? undefined
    : {
        ok: false,
        reason: "changed-underneath",
        path,
        onDisk: actual.text,
        stamp: actual.stamp,
      };
};

const changedUnderneath = (path: string, expected: FileStamp): ChangedUnderneath | undefined =>
  changedSnapshot(path, expected, readChapterFile(path));

/**
 * Freeze the bytes one decision intends to write.
 *
 * Rebuilding from the head alone flattens blank-line runs and line endings.
 * Preparing once lets the Decision Batch hash the same BOM, CRLF and spacing
 * that the file writer later commits instead of maintaining two serializers.
 */
export const prepareChapterWrite = (
  path: string,
  head: TextHead,
  expected?: FileStamp,
  root?: string,
): PreparedChapterWrite | ChangedUnderneath => {
  assertMutableChapterPath(path);
  if (root !== undefined) assertChapterInsideRoot(root, path);
  const onDisk = readChapterFile(path);
  if (expected !== undefined) {
    const changed = changedSnapshot(path, expected, onDisk);
    if (changed !== undefined) return changed;
  }
  const content =
    onDisk === undefined
      ? serializeChapter(head)
      : applyBlocks(parseSource(onDisk.text, blockPrefix(head.blocks)), head.blocks);
  return {
    ok: true,
    path,
    content,
    ...(expected === undefined ? {} : { expected }),
    ...(root === undefined ? {} : { root }),
  };
};

/** Commit a prepared byte plan, rechecking the external-edit boundary first. */
export const commitChapterWrite = (prepared: PreparedChapterWrite): WriteOutcome => {
  const { path, expected, root } = prepared;
  assertMutableChapterPath(path);
  if (root !== undefined) assertChapterInsideRoot(root, path);
  if (expected !== undefined) {
    const changed = changedUnderneath(path, expected);
    if (changed !== undefined) return changed;
  }
  if (root !== undefined) assertChapterInsideRoot(root, path);
  const atomic = replaceFileAtomically(path, prepared.content);
  const stamp = stampOf(path);
  if (stamp === undefined) throw new Error(`chapter vanished after save: ${path}`);
  return {
    ok: true,
    path,
    stamp,
    ...(atomic.recoveryEvidencePath === undefined
      ? {}
      : { recoveryEvidencePath: atomic.recoveryEvidencePath }),
  };
};

/**
 * Write a chapter, unless someone else wrote it first.
 *
 * The temp-file-and-rename keeps a crash mid-write from exposing a truncated
 * chapter. The digest comparison refuses an edit already visible when the save
 * begins. Passing no `expected` writes unconditionally for a new chapter.
 */
export const writeChapter = (
  path: string,
  head: TextHead,
  expected?: FileStamp,
  root?: string,
): WriteOutcome => {
  const prepared = prepareChapterWrite(path, head, expected, root);
  return prepared.ok ? commitChapterWrite(prepared) : prepared;
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
  // An id ends in `.md`; a title does not. Both may name a folder, because
  // material lives in one — what decides is the extension, not whether a
  // separator is present.
  const extension = extname(idOrTitle);
  const title = chapter === undefined && extension === ".md" ? idOrTitle.slice(0, -3) : idOrTitle;
  return writeChapter(
    chapter?.path ?? pathForNewChapter(project.root, title),
    head,
    expected,
    project.root,
  );
};
