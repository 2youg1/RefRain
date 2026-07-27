import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, normalize } from "node:path";
import { isSourceBackupPath, replaceStateFileAtomically } from "@refrain/core";

interface RootPermit {
  readonly path: string;
  readonly canonical: string;
  readonly kind: "file" | "folder";
  readonly device: string;
  readonly inode: string;
  readonly birth: string;
}

interface StoredPermits {
  readonly version: 1;
  readonly roots: readonly RootPermit[];
}

export type RootPermitStatus = "present" | "missing" | "denied";
const permitAt = (path: string): RootPermit => {
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
      permit = permitAt(path);
    } catch {
      return false;
    }
    this.#permits.set(permit.path, permit);
    this.#persist();
    return true;
  }

  /**
   * Whether a permit exists for this path, without asking the filesystem.
   *
   * SPEC Q25 splits the two questions. Opening a workspace only needs to know
   * the author once granted this path, and a drive cleaned between sessions
   * must not produce one warning per Root the author did not ask to open.
   * Identity is checked by `status` on the first call that uses the Root.
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
