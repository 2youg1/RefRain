/**
 * The file layer's TypeScript face.
 *
 * The native binding is loaded once, lazily, and the failure is explicit: a
 * missing `.node` means the platform binary was never built for this machine,
 * and pretending otherwise would surface later as an unreadable crash inside an
 * unrelated call.
 *
 * Nothing here reimplements the Rust. Every function is a named passage through
 * to it, so a reader can see the whole surface in one screen and the domain
 * vocabulary stays single-authority (SPEC §2).
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { arch, platform } from "node:process";

export type EntryKind = "file" | "directory" | "symlink";

/** One entry in the workspace index. Mirrors `index::Entry` across the boundary. */
export interface Entry {
  readonly path: string;
  readonly name: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly modifiedMs: number;
  readonly depth: number;
  /** True when this application can edit the file. */
  readonly manuscript: boolean;
}

/** A ranked match. `positions` are character offsets into `entry.name`. */
export interface Hit {
  readonly entry: Entry;
  readonly score: number;
  readonly positions: readonly number[];
}

export interface ScanOptions {
  readonly hidden?: boolean;
  readonly respectIgnore?: boolean;
  readonly followSymlinks?: boolean;
  readonly maxDepth?: number;
  readonly manuscriptsOnly?: boolean;
}

export type SortOrder = "name" | "modified" | "size" | "kind";

/** The result of trashing one path in a batch. */
export interface TrashOutcome {
  readonly path: string;
  readonly trashed: boolean;
  /** A stable code to branch on, e.g. `NO_TRASH_HERE`. Never a sentence. */
  readonly code?: string;
  /** The same failure written for a person. Never parsed. */
  readonly error?: string;
}

interface NativeWorkspace {
  scan(): number;
  readonly size: number;
  page(offset: number, limit: number): Entry[];
  search(query: string, limit: number): Hit[];
  searchDirectories(query: string, limit: number): Hit[];
  sort(order: SortOrder, descending: boolean): void;
  moveEntry(from: string, to: string, replace?: boolean): string;
  copyEntry(from: string, to: string, replace?: boolean): string;
  trash(target: string): string;
  trashViaHome(target: string): string;
  trashAll(targets: string[]): TrashOutcome[];
  link(target: string, linkPath: string): string;
  createDirectory(path: string): string;
  uniqueName(desired: string): string;
  admits(path: string): boolean;
}

interface Native {
  Workspace: new (roots: string[], options?: Record<string, unknown>) => NativeWorkspace;
}

/**
 * Where the platform binary sits. One file per platform-arch pair, named so a
 * packaged app can ship several and load exactly one.
 */
export const binaryName = (): string => `refrain-fs.${platform}-${arch}.node`;

let cached: Native | undefined;

/**
 * Load the native binding.
 *
 * `createRequire` rather than a bare import: the artefact is a CommonJS addon,
 * and Electron's main process resolves it through the same mechanism.
 *
 * Four locations, in the order they become true: the packaged app's resources
 * directory, the built binary beside this package, and the two Cargo output
 * paths a developer has before running the build script. A packaged app looks
 * in a place that does not exist during development and the reverse, so both
 * have to be tried rather than chosen.
 */
export const native = (): Native => {
  if (cached) return cached;

  const require = createRequire(import.meta.url);
  // `resourcesPath` exists only under Electron, and this package must not
  // depend on Electron's types to say so — the file layer is usable from a
  // plain Node script and from `bun test`.
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? [join(resources, binaryName())] : [];

  const candidates = [
    ...packaged,
    `../${binaryName()}`,
    "../target/release/librefrain_fs.so",
    "../target/release/librefrain_fs.dylib",
    "../target/release/refrain_fs.dll",
  ];

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      cached = require(candidate) as Native;
      return cached;
    } catch (error) {
      failures.push(`${candidate}: ${(error as Error).message}`);
    }
  }

  throw new Error(
    `RefRain's file layer has no binary for ${platform}-${arch}. Build it with ` +
      `\`bun run native\`. Tried:\n${failures.join("\n")}`,
  );
};

/**
 * A workspace: several roots, one index, one guard.
 *
 * The index stays in Rust. Pulling 100k entries across the boundary to filter
 * them in JavaScript would cost a structured clone per keystroke, which is the
 * cost this layer exists to remove.
 */
export class Workspace {
  readonly #inner: NativeWorkspace;

  constructor(roots: readonly string[], options: ScanOptions = {}) {
    this.#inner = new (native().Workspace)([...roots], {
      hidden: options.hidden,
      respectIgnore: options.respectIgnore,
      followSymlinks: options.followSymlinks,
      maxDepth: options.maxDepth,
      manuscriptsOnly: options.manuscriptsOnly,
    });
  }

  /** Walk the roots and replace the index. Returns the entry count. */
  scan(): number {
    return this.#inner.scan();
  }

  get size(): number {
    return this.#inner.size;
  }

  /** A window of the index, for a virtualised tree. */
  page(offset: number, limit: number): readonly Entry[] {
    return this.#inner.page(offset, limit);
  }

  search(query: string, limit = 50): readonly Hit[] {
    return this.#inner.search(query, limit);
  }

  searchDirectories(query: string, limit = 50): readonly Hit[] {
    return this.#inner.searchDirectories(query, limit);
  }

  sort(order: SortOrder, descending = false): void {
    this.#inner.sort(order, descending);
  }

  move(from: string, to: string, replace = false): string {
    return this.#inner.moveEntry(from, to, replace);
  }

  copy(from: string, to: string, replace = false): string {
    return this.#inner.copyEntry(from, to, replace);
  }

  /**
   * Delete to the system trash.
   *
   * There is no permanent delete on this class, and adding one is a product
   * decision rather than a convenience: a writer who loses a chapter to a
   * misclick has lost the work this application exists to protect.
   */
  trash(target: string): string {
    return this.#inner.trash(target);
  }

  /** Trash a selection, reporting each path separately. */
  /**
   * Trash by way of the volume holding the user's home (SPEC Q8).
   *
   * For when `trash` refused with `NO_TRASH_HERE`. Still recoverable from the
   * operating system; still not a permanent delete.
   */
  trashViaHome(target: string): string {
    return this.#inner.trashViaHome(target);
  }

  trashAll(targets: readonly string[]): readonly TrashOutcome[] {
    return this.#inner.trashAll([...targets]);
  }

  link(target: string, linkPath: string): string {
    return this.#inner.link(target, linkPath);
  }

  createDirectory(path: string): string {
    return this.#inner.createDirectory(path);
  }

  /** A non-colliding name, with the suffix before the extension. */
  uniqueName(desired: string): string {
    return this.#inner.uniqueName(desired);
  }

  /** Whether a path would be admitted, without touching the disk. */
  admits(path: string): boolean {
    return this.#inner.admits(path);
  }
}
