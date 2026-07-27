import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  claimRootStorage,
  isSourceBackupPath,
  replaceStateFileAtomically,
  storageForRoot,
} from "@refrain/core";

interface RootPermit {
  readonly path: string;
  readonly canonical: string;
  readonly kind: "file" | "folder";
  readonly marker: string;
  readonly device: string;
  readonly inode: string;
  readonly birth: string;
}

interface StoredPermits {
  readonly version: 1;
  readonly roots: readonly RootPermit[];
}

export type RootPermitStatus = "present" | "missing" | "denied";

const ROOT_MARKER = "root-permit.json";
const markerAt = (path: string, kind: RootPermit["kind"], create: boolean): string => {
  const root = { path, kind } as const;
  const storage = create && kind === "file" ? claimRootStorage(root) : storageForRoot(root);
  if (!existsSync(storage.stateDir)) {
    if (!create) throw new Error(`Root marker is missing: ${storage.stateDir}`);
    mkdirSync(storage.stateDir, { recursive: true });
  }
  if (lstatSync(storage.stateDir).isSymbolicLink())
    throw new Error(`Root state directory is a symlink: ${storage.stateDir}`);

  const markerPath = join(storage.stateDir, ROOT_MARKER);
  const markerInfo = lstatSync(markerPath, { throwIfNoEntry: false });
  if (markerInfo?.isSymbolicLink()) throw new Error(`Root marker is a symlink: ${markerPath}`);
  if (markerInfo === undefined) {
    if (!create) throw new Error(`Root marker is missing: ${markerPath}`);
    try {
      writeFileSync(markerPath, `${JSON.stringify({ version: 1, id: randomUUID() }, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        flush: true,
      });
    } catch (error) {
      if (lstatSync(markerPath, { throwIfNoEntry: false }) === undefined) throw error;
    }
  }

  if (lstatSync(markerPath).isSymbolicLink())
    throw new Error(`Root marker is a symlink: ${markerPath}`);
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  if (marker.version !== 1 || typeof marker.id !== "string" || marker.id.length === 0)
    throw new Error(`Invalid Root marker: ${markerPath}`);
  return marker.id;
};

const permitAt = (path: string, createMarker = false): RootPermit => {
  const literal = normalize(path);
  if (isSourceBackupPath(literal))
    throw new Error(`Source Backup cannot be opened as a Root: ${literal}`);
  const canonical = realpathSync(literal);
  if (isSourceBackupPath(canonical))
    throw new Error(`Source Backup cannot be opened as a Root: ${canonical}`);
  const rootInfo = statSync(canonical, { bigint: true });
  const kind = rootInfo.isFile() ? "file" : "folder";
  const identity = kind === "file" ? statSync(dirname(canonical), { bigint: true }) : rootInfo;
  return {
    path: literal,
    canonical,
    kind,
    marker: markerAt(literal, kind, createMarker),
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    birth: identity.birthtimeNs.toString(),
  };
};

const validPermit = (value: unknown): value is RootPermit =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  typeof value.path === "string" &&
  "canonical" in value &&
  typeof value.canonical === "string" &&
  "kind" in value &&
  (value.kind === "file" || value.kind === "folder") &&
  "marker" in value &&
  typeof value.marker === "string" &&
  "device" in value &&
  typeof value.device === "string" &&
  "inode" in value &&
  typeof value.inode === "string" &&
  "birth" in value &&
  typeof value.birth === "string";

/**
 * Main-owned Root permission, durable across a renderer restart.
 *
 * The renderer may remember which Roots it wants to show, but cannot grant a
 * path permission by putting that path in localStorage. A picker, drop, create,
 * or OS-open event calls `approve`; every later mutation rechecks the pinned
 * canonical path and filesystem identity so a retargeted symlink loses access.
 */
export class RootAuthority {
  readonly #storagePath: string | undefined;
  readonly #permits = new Map<string, RootPermit>();

  constructor(storagePath?: string) {
    this.#storagePath = storagePath;
    if (!storagePath || !existsSync(storagePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(storagePath, "utf8")) as Partial<StoredPermits>;
      if (parsed.version !== 1 || !Array.isArray(parsed.roots))
        throw new Error("invalid Root permit file");
      for (const permit of parsed.roots) {
        if (validPermit(permit)) this.#permits.set(normalize(permit.path), permit);
      }
    } catch (error) {
      console.warn(`Root permissions unavailable: ${String(error)}`);
    }
  }

  approve(path: string): boolean {
    let permit: RootPermit;
    try {
      permit = permitAt(path, true);
    } catch {
      return false;
    }
    const previous = this.#permits.get(permit.path);
    this.#permits.set(permit.path, permit);
    try {
      this.#persist();
      return true;
    } catch {
      if (previous === undefined) this.#permits.delete(permit.path);
      else this.#permits.set(permit.path, previous);
      return false;
    }
  }

  /**
   * Whether a permit exists for this path, without asking the filesystem.
   *
   * SPEC Q25 splits permission from identity so callers can distinguish a path
   * that was never granted from one that is permitted but currently missing.
   * `status` must still guard any operation that reads or writes the Root,
   * including workspace adoption.
   */
  holds(path: string): boolean {
    const literal = normalize(path);
    return this.#permits.has(literal) && !isSourceBackupPath(literal);
  }

  status(path: string): RootPermitStatus {
    const literal = normalize(path);
    const approved = this.#permits.get(literal);
    if (!approved || isSourceBackupPath(literal)) return "denied";
    if (!existsSync(literal)) return "missing";
    try {
      const current = permitAt(literal);
      return current.canonical === approved.canonical &&
        current.kind === approved.kind &&
        current.marker === approved.marker &&
        current.device === approved.device &&
        current.inode === approved.inode &&
        current.birth === approved.birth
        ? "present"
        : "denied";
    } catch {
      return "denied";
    }
  }

  #persist(): void {
    if (!this.#storagePath) return;
    mkdirSync(dirname(this.#storagePath), { recursive: true });
    replaceStateFileAtomically(
      this.#storagePath,
      `${JSON.stringify({ version: 1, roots: [...this.#permits.values()] }, null, 2)}\n`,
    );
  }
}
