import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextHead } from "../src/index.ts";
import { loadProject, stampOf, writeChapter } from "../src/index.ts";

/**
 * The file is the truth (SPEC axiom 1), and this application used to ignore it.
 *
 * `writeChapter` trusted the caller's cached head as the state of the disk, so
 * a chapter the author had edited in another editor — or that a script or a git
 * checkout had touched — was overwritten on the next save with no warning. The
 * manuscript is the one thing RefRain promises never to damage, and this was
 * the shortest path to damaging it.
 */

const scratch = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "refrain-stamp-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const headOf = (text: string): TextHead => ({
  id: "h1",
  blocks: text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t, i) => ({ id: `b${i}`, text: t })),
  cause: "author edit",
});

/**
 * A filesystem with one-second mtime granularity cannot distinguish two writes
 * in the same second, which is why the stamp carries the byte count too. The
 * tests change the length as well, so they hold on every filesystem rather than
 * only on the fast ones.
 */
describe("a chapter is not overwritten when the file moved on", () => {
  test("an unchanged file is written and the stamp advances", () => {
    const { root, cleanup } = scratch();
    try {
      const path = join(root, "第一章.md");
      writeFileSync(path, "原来的一句。\n", "utf8");
      const before = stampOf(path);
      expect(before).toBeDefined();

      const outcome = writeChapter(path, headOf("改写过的一句。"), before);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(readFileSync(path, "utf8")).toBe("改写过的一句。\n");
      expect(outcome.stamp.bytes).not.toBe(before?.bytes);
    } finally {
      cleanup();
    }
  });

  test("a file edited underneath is refused, and keeps the other edit", () => {
    const { root, cleanup } = scratch();
    try {
      const path = join(root, "第一章.md");
      writeFileSync(path, "原来的一句。\n", "utf8");
      const stale = stampOf(path);

      // Someone else writes — another editor, a script, a checkout.
      writeFileSync(path, "别处改写的一句，长度也不同。\n", "utf8");

      const outcome = writeChapter(path, headOf("这边写的一句。"), stale);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe("changed-underneath");
      // The refusal carries the disk's text, so the interface can show both.
      expect(outcome.onDisk).toBe("别处改写的一句，长度也不同。\n");
      // And the other edit is still there: nothing was lost.
      expect(readFileSync(path, "utf8")).toBe("别处改写的一句，长度也不同。\n");
    } finally {
      cleanup();
    }
  });

  test("writing without a stamp is unconditional, for a file being created", () => {
    const { root, cleanup } = scratch();
    try {
      const path = join(root, "新章.md");
      const outcome = writeChapter(path, headOf("第一句。"));
      expect(outcome.ok).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("第一句。\n");
    } finally {
      cleanup();
    }
  });

  /**
   * A file the author deleted or moved is not a conflict. They asked for it to
   * exist again by pressing save, and refusing would strand their text with
   * nowhere to put it.
   */
  test("a file that has since vanished is written rather than refused", () => {
    const { root, cleanup } = scratch();
    try {
      const path = join(root, "第一章.md");
      writeFileSync(path, "原来的一句。\n", "utf8");
      const stamp = stampOf(path);
      rmSync(path);

      const outcome = writeChapter(path, headOf("回来的一句。"), stamp);

      expect(outcome.ok).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("回来的一句。\n");
    } finally {
      cleanup();
    }
  });

  test("a loaded chapter carries the stamp a later save needs", () => {
    const { root, cleanup } = scratch();
    try {
      writeFileSync(join(root, "第一章.md"), "一句。\n", "utf8");
      const chapter = loadProject(root).chapters[0];

      expect(chapter?.stamp).toBeDefined();
      expect(chapter?.stamp?.bytes).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
