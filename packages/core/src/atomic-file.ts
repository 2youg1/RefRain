import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type AtomicWriteCheckpoint = "written" | "file-synced" | "renamed" | "directory-synced";

export type AtomicWriteObserver = (checkpoint: AtomicWriteCheckpoint) => void;

const syncDirectory = (path: string): void => {
  if (process.platform === "win32") return;
  const directory = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

/**
 * Replace one file without exposing a partial canonical version.
 *
 * The temporary file lives beside the target so rename stays on one filesystem.
 * An existing temporary file is never overwritten: it may be the only complete
 * version left by an interrupted save and therefore remains evidence for
 * recovery. The observer exists for crash-boundary tests; application callers
 * do not need one.
 */
export const replaceFileAtomically = (
  path: string,
  content: string | Uint8Array,
  observe?: AtomicWriteObserver,
): void => {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temporary = `${path}.writing`;
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
};
