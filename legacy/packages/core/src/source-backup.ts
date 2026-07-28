/**
 * The Source Backup: the manuscript as it was before this application opened it.
 *
 * Invariant 4 says the Source Backup is never written to, and four Rust tests
 * plus `verify:trash-only` enforce that. None of them noticed that nothing
 * created one. `.refrain-source` was a constant in two files, a refusal in the
 * guard, a skip in the index, and a reserved name in `project.ts` — a lock on a
 * door with no room behind it.
 *
 * That gap costs most in the recovery paths. A leftover `.writing` file can be
 * compared against the original to tell an interrupted save from a newer one;
 * a block that survives a round trip can be checked against the bytes the
 * author actually handed over. Without an original, both fall back to guessing.
 *
 * The copy is taken once, when a root is first adopted, and never again — a
 * second copy would record the application's own edits as if they were the
 * author's.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { claimRootStorage, type RootLocation, type RootStorage } from "./root-storage.ts";

/** Matches `SOURCE_BACKUP_DIR` in `guard.rs` and `project.ts`. */
export const SOURCE_BACKUP_DIR = ".refrain-source";

const MANIFEST = "taken.json";
const EMPTY_ADOPTION_FILE = "source-backup.json";

export interface BackupOutcome {
  readonly kind: "taken" | "already-present" | "nothing-to-copy" | "refused";
  /** Files copied. Zero for every kind but `taken`. */
  readonly files: number;
  /** Present when `refused`: why, in the author's terms. */
  readonly reason?: string;
}

/** Markdown is what this application edits, so Markdown is what it preserves. */
const MANUSCRIPT = /\.(md|markdown|mdown|txt)$/i;

const manuscriptsUnder = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...manuscriptsUnder(full));
    else if (MANUSCRIPT.test(entry.name)) found.push(full);
  }
  return found;
};

/**
 * Take the backup if this Root has never had one.
 *
 * A folder copies its manuscript tree. A single-file Root copies only that
 * file into its adjacent companion; nothing in the parent directory becomes
 * part of the Project merely because it is nearby.
 */
export const takeSourceBackup = (root: RootLocation): BackupOutcome => {
  let storage: RootStorage;
  try {
    storage = claimRootStorage(root);
  } catch (error) {
    return { kind: "refused", files: 0, reason: `无法建立项目存储：${String(error)}` };
  }

  const backup = storage.sourceBackupDir;
  const emptyAdoption = join(storage.stateDir, EMPTY_ADOPTION_FILE);
  if (existsSync(join(backup, MANIFEST)) || existsSync(emptyAdoption))
    return { kind: "already-present", files: 0 };

  let manuscripts: string[];
  try {
    manuscripts = root.kind === "file" ? [root.path] : manuscriptsUnder(root.path);
  } catch (error) {
    return { kind: "refused", files: 0, reason: `无法读取项目内容：${String(error)}` };
  }

  if (manuscripts.length === 0) {
    const staged = `${emptyAdoption}.writing`;
    try {
      mkdirSync(dirname(emptyAdoption), { recursive: true });
      writeFileSync(
        staged,
        `${JSON.stringify({ adopted: new Date().toISOString(), source: "nothing-to-copy" }, null, 2)}\n`,
        { flush: true },
      );
      renameSync(staged, emptyAdoption);
    } catch (error) {
      return { kind: "refused", files: 0, reason: `无法记录项目初始状态：${String(error)}` };
    }
    return { kind: "nothing-to-copy", files: 0 };
  }

  try {
    mkdirSync(backup, { recursive: true });
    for (const source of manuscripts) {
      const name = root.kind === "file" ? basename(source) : relative(root.path, source);
      const target = join(backup, name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
    /*
     * The manifest is written last and is what `already-present` tests for. A
     * copy interrupted halfway leaves no manifest, so the next open retries
     * instead of trusting a partial original — which would be worse than none,
     * because the recovery paths would believe it.
     */
    writeFileSync(
      join(backup, MANIFEST),
      `${JSON.stringify({ taken: new Date().toISOString(), files: manuscripts.length }, null, 2)}\n`,
      { flush: true },
    );
  } catch (error) {
    return { kind: "refused", files: 0, reason: `无法写入原件副本：${String(error)}` };
  }

  return { kind: "taken", files: manuscripts.length };
};
