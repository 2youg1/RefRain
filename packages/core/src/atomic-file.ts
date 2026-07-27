import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type AtomicWriteCheckpoint =
  | "recovery-linked"
  | "recovery-directory-synced"
  | "recovery-unlinked"
  | "written"
  | "file-synced"
  | "renamed"
  | "directory-synced";

export type AtomicWriteObserver = (checkpoint: AtomicWriteCheckpoint) => void;

export interface AtomicWriteResult {
  readonly recoveryEvidencePath?: string;
}

export class AtomicWriteFailure extends Error {
  readonly recoveryEvidencePath: string;

  constructor(error: unknown, recoveryEvidencePath: string) {
    const detail = error instanceof Error ? error.message : String(error);
    super(`${detail}; interrupted-write evidence is preserved at ${recoveryEvidencePath}`, {
      cause: error,
    });
    this.name = "AtomicWriteFailure";
    this.recoveryEvidencePath = recoveryEvidencePath;
  }
}

const syncDirectory = (path: string): void => {
  if (process.platform === "win32") return;
  const directory = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const OWNER = "refrain-atomic-write-v1\n";

export const interruptedWriteMarkerPath = (path: string): string => `${path}.writing.refrain-owner`;

export const ownsInterruptedWrite = (path: string): boolean => {
  try {
    return readFileSync(interruptedWriteMarkerPath(path), "utf8") === OWNER;
  } catch {
    return false;
  }
};

const removeMarker = (path: string, parent: string): void => {
  const marker = interruptedWriteMarkerPath(path);
  if (!existsSync(marker)) return;
  unlinkSync(marker);
  syncDirectory(parent);
};

const markTemporary = (path: string, parent: string): void => {
  const marker = interruptedWriteMarkerPath(path);
  writeFileSync(marker, OWNER, { encoding: "utf8", flag: "wx" });
  // Opened for writing even though nothing more is written: Windows refuses to
  // flush a handle that carries no write access, so a read-only descriptor made
  // `FlushFileBuffers` fail with EPERM and took every state write down with it.
  // Unix allows the flush either way, which is why this only ever showed up on
  // the release platform.
  const file = openSync(marker, constants.O_RDWR);
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  syncDirectory(parent);
};

const preserveTemporary = (
  temporary: string,
  parent: string,
  observe?: AtomicWriteObserver,
): string => {
  const timestamp = Date.now();
  for (let sequence = 0; ; sequence += 1) {
    const suffix = new Date(timestamp + sequence).toISOString().replaceAll(":", "-");
    const evidence = `${temporary}.${suffix}`;
    try {
      linkSync(temporary, evidence);
    } catch (error) {
      if (hasCode(error, "EEXIST")) continue;
      throw error;
    }

    try {
      observe?.("recovery-linked");
      // O_RDWR, not O_RDONLY: Windows will not flush a handle without write
      // access. See `markTemporary` — the same rule, the same platform.
      const file = openSync(evidence, constants.O_RDWR);
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      // The second name is durable before the original name is removed. A
      // crash on either side of the unlink therefore leaves at least one name
      // for the same inode rather than a copy gap that can lose both.
      syncDirectory(parent);
      observe?.("recovery-directory-synced");
      unlinkSync(temporary);
      observe?.("recovery-unlinked");
      syncDirectory(parent);
      return evidence;
    } catch (error) {
      throw new AtomicWriteFailure(error, evidence);
    }
  }
};

const recoverTemporary = (
  path: string,
  temporary: string,
  parent: string,
  observe?: AtomicWriteObserver,
): string | undefined => {
  if (!existsSync(temporary)) return undefined;
  if (existsSync(path) && readFileSync(temporary).equals(readFileSync(path))) {
    unlinkSync(temporary);
    syncDirectory(parent);
    return undefined;
  }
  return preserveTemporary(temporary, parent, observe);
};

/**
 * Resolve the residue of one interrupted atomic replacement without starting a
 * new write. Startup calls this before any state or manuscript writer can hide
 * the evidence by opening the same target again.
 */
export const recoverInterruptedWrite = (
  path: string,
  observe?: AtomicWriteObserver,
): AtomicWriteResult => {
  const parent = dirname(path);
  const recoveryEvidencePath = recoverTemporary(path, `${path}.writing`, parent, observe);
  removeMarker(path, parent);
  return recoveryEvidencePath === undefined ? {} : { recoveryEvidencePath };
};

/**
 * State files have no user-facing return channel for recovery evidence.
 *
 * Preserve an interrupted candidate, then stop before replacing the canonical
 * state. The failure message carries the evidence path; a retry writes normally.
 */
export const replaceStateFileAtomically = (path: string, content: string | Uint8Array): void => {
  replaceAtomically(path, content, undefined, true);
};

/**
 * Replace a file without ever exposing a partial destination.
 *
 * The temporary file lives beside the target so rename stays on one filesystem.
 * A temporary file left by an interrupted save is recovered before a new one is
 * opened. If it duplicates the canonical file it is redundant and removed. If
 * it differs, it is preserved beside the target with a timestamp so the candidate
 * remains available to the author while the requested save proceeds. The
 * observer exists for crash-boundary tests; application callers do not need one.
 */
const replaceAtomically = (
  path: string,
  content: string | Uint8Array,
  observe?: AtomicWriteObserver,
  stopAfterRecovery = false,
): AtomicWriteResult => {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temporary = `${path}.writing`;
  const recoveryEvidencePath = recoverTemporary(path, temporary, parent, observe);
  if (stopAfterRecovery && recoveryEvidencePath !== undefined)
    throw new AtomicWriteFailure(
      new Error("state write stopped after recovering an interrupted candidate"),
      recoveryEvidencePath,
    );
  removeMarker(path, parent);
  markTemporary(path, parent);

  try {
    const mode = existsSync(path) ? statSync(path).mode : 0o666;
    const file = openSync(temporary, "wx", mode);

    try {
      writeFileSync(file, content);
      observe?.("written");
      fsyncSync(file);
      observe?.("file-synced");
    } finally {
      closeSync(file);
    }

    renameSync(temporary, path);
    observe?.("renamed");
    syncDirectory(parent);
    observe?.("directory-synced");
    removeMarker(path, parent);
    return recoveryEvidencePath === undefined ? {} : { recoveryEvidencePath };
  } catch (error) {
    if (recoveryEvidencePath !== undefined)
      throw new AtomicWriteFailure(error, recoveryEvidencePath);
    throw error;
  }
};

export const replaceFileAtomically = (
  path: string,
  content: string | Uint8Array,
  observe?: AtomicWriteObserver,
): AtomicWriteResult => replaceAtomically(path, content, observe);
