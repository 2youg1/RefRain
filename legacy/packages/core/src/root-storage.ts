import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface RootLocation {
  readonly path: string;
  readonly kind: "folder" | "file";
}

export interface RootStorage {
  /** State that RefRain may rewrite. */
  readonly stateDir: string;
  /** The immutable original, outside every ordinary state writer. */
  readonly sourceBackupDir: string;
  /** Present only for a single-file Root. */
  readonly companionDir?: string;
}

const FILE_ROOT_LAYOUT = "root.json";
const FILE_ROOT_SIGNATURE = { layout: "refrain-file-root", version: 1 } as const;

/**
 * A lone file owns one adjacent companion without adopting any neighbour.
 *
 * Keeping the source and `.<name>.refrain` together preserves project state
 * when their parent folder moves. The companion contains the same two
 * authorities a folder Root does: mutable `.refrain` state and the immutable
 * `.refrain-source` original.
 */
export const storageForRoot = (root: RootLocation): RootStorage => {
  if (root.kind === "folder")
    return {
      stateDir: join(root.path, ".refrain"),
      sourceBackupDir: join(root.path, ".refrain-source"),
    };

  const companionDir = join(dirname(root.path), `.${basename(root.path)}.refrain`);
  return {
    companionDir,
    stateDir: join(companionDir, ".refrain"),
    sourceBackupDir: join(companionDir, ".refrain-source"),
  };
};

/**
 * Claim or verify a single-file companion before any writer enters it.
 *
 * An existing ordinary directory or symlink is not ours. Refusing it avoids
 * turning a name collision into writes outside the Root's authority.
 */
export const claimRootStorage = (root: RootLocation): RootStorage => {
  const storage = storageForRoot(root);
  if (!storage.companionDir) return storage;

  const marker = join(storage.companionDir, FILE_ROOT_LAYOUT);
  if (!existsSync(storage.companionDir)) {
    mkdirSync(storage.companionDir);
    writeFileSync(marker, `${JSON.stringify(FILE_ROOT_SIGNATURE, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    return storage;
  }

  if (lstatSync(storage.companionDir).isSymbolicLink())
    throw new Error(`single-file Root companion is a symlink: ${storage.companionDir}`);
  const found = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
  if (found.layout !== FILE_ROOT_SIGNATURE.layout || found.version !== FILE_ROOT_SIGNATURE.version)
    throw new Error(`single-file Root companion is not owned by RefRain: ${storage.companionDir}`);
  return storage;
};
