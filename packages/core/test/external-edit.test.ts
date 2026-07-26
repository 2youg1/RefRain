import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TextHead } from "../src/index.ts";
import {
  type AtomicWriteCheckpoint,
  loadProject,
  readChapterFile,
  replaceFileAtomically,
  saveChapter,
  stampOf,
  writeChapter,
} from "../src/index.ts";

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

  test("an edit with the same mtime and byte count is still refused", () => {
    const { root, cleanup } = scratch();
    try {
      const path = join(root, "第一章.md");
      writeFileSync(path, "甲说：可以。\n", "utf8");
      const stale = stampOf(path);
      expect(stale).toBeDefined();

      writeFileSync(path, "乙说：不可。\n", "utf8");
      const seconds = (stale?.modifiedMs ?? 0) / 1000;
      utimesSync(path, seconds, seconds);
      expect(stampOf(path)).toMatchObject({
        modifiedMs: stale?.modifiedMs,
        bytes: stale?.bytes,
      });

      const outcome = writeChapter(path, headOf("这边仍在写。"), stale);

      expect(outcome.ok).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("乙说：不可。\n");
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

  test("a read error is not mistaken for a missing chapter", () => {
    const { root, cleanup } = scratch();
    try {
      const path = join(root, "第一章.md");
      writeFileSync(path, "原来的一句。\n", "utf8");
      const expected = stampOf(path);
      rmSync(path);
      mkdirSync(path);

      expect(() => readChapterFile(path)).toThrow();
      expect(() => writeChapter(path, headOf("这边仍在写。"), expected)).toThrow();
      expect(existsSync(`${path}.writing`)).toBe(false);
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

describe("a chapter replacement is durable at every crash boundary", () => {
  for (const checkpoint of ["written", "file-synced", "renamed"] as const) {
    test(`stopping after ${checkpoint} leaves one complete canonical version`, () => {
      const { root, cleanup } = scratch();
      try {
        const path = join(root, "第一章.md");
        const temporary = `${path}.writing`;
        writeFileSync(path, "完整旧版。\n", "utf8");

        expect(() =>
          replaceFileAtomically(path, "完整新版。\n", (reached: AtomicWriteCheckpoint) => {
            if (reached === checkpoint) throw new Error(`stopped after ${checkpoint}`);
          }),
        ).toThrow(`stopped after ${checkpoint}`);

        expect(readFileSync(path, "utf8")).toBe(
          checkpoint === "renamed" ? "完整新版。\n" : "完整旧版。\n",
        );
        expect(existsSync(temporary)).toBe(checkpoint !== "renamed");
        if (existsSync(temporary)) expect(readFileSync(temporary, "utf8")).toBe("完整新版。\n");
      } finally {
        cleanup();
      }
    });
  }

  test("SIGKILL at each checkpoint leaves the same old-or-new guarantee", () => {
    const child = fileURLToPath(new URL("./atomic-write-child.ts", import.meta.url));

    for (const checkpoint of ["written", "file-synced", "renamed"] as const) {
      const { root, cleanup } = scratch();
      try {
        const path = join(root, `${checkpoint}.md`);
        const temporary = `${path}.writing`;
        writeFileSync(path, "完整旧版。\n", "utf8");

        const stopped = spawnSync(process.execPath, [child, path, checkpoint]);

        expect(stopped.status === 0).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(
          checkpoint === "renamed" ? "完整新版。\n" : "完整旧版。\n",
        );
        expect(existsSync(temporary)).toBe(checkpoint !== "renamed");
      } finally {
        cleanup();
      }
    }
  });
});

describe("the Source Backup is immutable", () => {
  test("opening the backup itself as a project still grants no write path", () => {
    const { root, cleanup } = scratch();
    try {
      const backup = join(root, ".refrain-source");
      const path = join(backup, "original.md");
      mkdirSync(backup);
      writeFileSync(path, "不可改写的原稿。\n", "utf8");
      const before = createHash("sha256").update(readFileSync(path)).digest("hex");
      const project = loadProject(backup);

      expect(() =>
        saveChapter(project, "original", headOf("试图改写。"), project.chapters[0]?.stamp),
      ).toThrow(/Source Backup is never written to/);

      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
      expect(existsSync(`${path}.writing`)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
