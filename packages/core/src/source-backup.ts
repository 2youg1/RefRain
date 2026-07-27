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
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Matches `SOURCE_BACKUP_DIR` in `guard.rs` and `project.ts`. */
export const SOURCE_BACKUP_DIR = ".refrain-source";

const MANIFEST = "taken.json";

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
 * Take the backup if this root has never had one.
 *
 * Returns rather than throws: a root whose backup cannot be written is still a
 * root the author can edit, and refusing to open their manuscript over a
 * failed safety copy would trade a large loss for a small one.
 */
export const takeSourceBackup = (root: string): BackupOutcome => {
  const backup = join(root, SOURCE_BACKUP_DIR);
  if (existsSync(join(backup, MANIFEST))) return { kind: "already-present", files: 0 };

  let manuscripts: string[];
  try {
    manuscripts = manuscriptsUnder(root);
  } catch (error) {
    return { kind: "refused", files: 0, reason: `无法读取项目内容：${String(error)}` };
  }

  if (manuscripts.length === 0) return { kind: "nothing-to-copy", files: 0 };

  try {
    mkdirSync(backup, { recursive: true });
    for (const source of manuscripts) {
      const target = join(backup, source.slice(root.length + 1));
      mkdirSync(join(target, ".."), { recursive: true });
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
    );
  } catch (error) {
    return { kind: "refused", files: 0, reason: `无法写入原件副本：${String(error)}` };
  }

  return { kind: "taken", files: manuscripts.length };
};
