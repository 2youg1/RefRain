/**
 * The Source Backup exists, is taken once, and is never taken again.
 *
 * Invariant 4 forbids writing to the Source Backup, and four Rust tests plus
 * `verify:trash-only` enforce that refusal. Every one of them passed while
 * nothing in the product ever created one — the tests each `mkdir`ed the
 * directory themselves before asserting it was refused, so the guard was
 * proved to work on a directory that only existed inside the test.
 *
 * These tests come at it from the other side: they assert the original is
 * actually taken, and that a second open does not overwrite it with the
 * author's later edits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_BACKUP_DIR, takeSourceBackup } from "../src/source-backup";

const made: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "refrain-backup-"));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the Source Backup", () => {
  test("keeps the manuscript as it was when the root was adopted", () => {
    const root = scratch();
    writeFileSync(join(root, "01.md"), "　　原文第一段。\n");
    mkdirSync(join(root, "資料"));
    writeFileSync(join(root, "資料", "年表.md"), "1931\n");

    const outcome = takeSourceBackup(root);
    expect(outcome.kind).toBe("taken");
    expect(outcome.files).toBe(2);

    expect(readFileSync(join(root, SOURCE_BACKUP_DIR, "01.md"), "utf8")).toBe("　　原文第一段。\n");
    expect(readFileSync(join(root, SOURCE_BACKUP_DIR, "資料", "年表.md"), "utf8")).toBe("1931\n");
  });

  /* The whole point: the original must not drift toward the working copy. */
  test("a second open does not overwrite the original with later edits", () => {
    const root = scratch();
    writeFileSync(join(root, "01.md"), "原文。\n");
    takeSourceBackup(root);

    writeFileSync(join(root, "01.md"), "作者改过的。\n");
    const again = takeSourceBackup(root);

    expect(again.kind).toBe("already-present");
    expect(readFileSync(join(root, SOURCE_BACKUP_DIR, "01.md"), "utf8")).toBe("原文。\n");
  });

  test("an empty adopted folder never turns later RefRain text into an original", () => {
    const root = scratch();
    expect(takeSourceBackup(root).kind).toBe("nothing-to-copy");
    expect(existsSync(join(root, SOURCE_BACKUP_DIR))).toBe(false);

    writeFileSync(join(root, "01.md"), "在 RefRain 内新写的。\n");
    expect(takeSourceBackup(root).kind).toBe("already-present");
    expect(existsSync(join(root, SOURCE_BACKUP_DIR))).toBe(false);
  });

  /*
   * State and backup directories are the application's, not the author's.
   *
   * The first version of this test put a `.refrain/state.json` in the way,
   * which proved nothing: `state.json` is not Markdown, so the file filter
   * would have skipped it even with the dot-directory rule deleted. What the
   * rule actually prevents is the backup copying itself — a second open would
   * otherwise nest the original inside the original, once per open.
   */
  test("does not copy the application's own directories into the original", () => {
    const root = scratch();
    writeFileSync(join(root, "01.md"), "原文。\n");
    mkdirSync(join(root, ".refrain"));
    writeFileSync(join(root, ".refrain", "notes.md"), "应用自己的\n");

    expect(takeSourceBackup(root).files).toBe(1);
    expect(existsSync(join(root, SOURCE_BACKUP_DIR, ".refrain"))).toBe(false);
    expect(existsSync(join(root, SOURCE_BACKUP_DIR, SOURCE_BACKUP_DIR))).toBe(false);
  });

  /*
   * A partial copy is worse than none: the recovery paths would believe it.
   * The manifest is written last, so its absence means "retry", not "done".
   */
  test("an interrupted copy is retried rather than trusted", () => {
    const root = scratch();
    writeFileSync(join(root, "01.md"), "原文。\n");

    mkdirSync(join(root, SOURCE_BACKUP_DIR), { recursive: true });
    writeFileSync(join(root, SOURCE_BACKUP_DIR, "01.md"), "半截。\n");

    expect(takeSourceBackup(root).kind).toBe("taken");
    expect(readFileSync(join(root, SOURCE_BACKUP_DIR, "01.md"), "utf8")).toBe("原文。\n");
  });
});
