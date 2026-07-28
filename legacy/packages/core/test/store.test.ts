import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "../src/index.ts";
import { currentText, loadProject, saveChapter, VerdictLedger } from "../src/index.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refrain-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("files are truth", () => {
  test("a chapter round-trips through plain Markdown on disk", () => {
    writeFileSync(join(root, "01-opening.md"), "黑暗中有人问。\n\n声音很熟。\n");

    const project = loadProject(root);

    expect(project.chapters).toHaveLength(1);
    expect(project.chapters[0]?.title).toBe("01-opening");
    expect(currentText(project.chapters[0]!.head)).toBe("黑暗中有人问。\n\n声音很熟。");
  });

  test("saving writes Markdown a reader can edit without this application", () => {
    writeFileSync(join(root, "01.md"), "甲。\n");
    const project = loadProject(root);

    saveChapter(project, "01", {
      id: "h1",
      blocks: [
        { id: "b1", text: "甲。" },
        { id: "b2", text: "乙。" },
      ],
      cause: "test",
    });

    expect(readFileSync(join(root, "01.md"), "utf8")).toBe("甲。\n\n乙。\n");
  });

  test("a project with no chapters loads rather than throwing", () => {
    expect(loadProject(root).chapters).toEqual([]);
  });

  test("a directory whose name ends in .md is ignored", () => {
    mkdirSync(join(root, "notes.md"));
    writeFileSync(join(root, "01.md"), "甲。\n");

    expect(loadProject(root).chapters.map((chapter) => chapter.title)).toEqual(["01"]);
  });

  test("a new chapter title cannot escape the project root", () => {
    const outside = join(root, "..", "escaped.md");
    const project = loadProject(root);
    const head = { id: "h1", blocks: [{ id: "b1", text: "甲。" }], cause: "test" };

    const invalid = [
      "../escaped",
      "..\\escaped",
      "bad\0name",
      "nul",
      "chapter.",
      "chapter ",
      "a:b",
    ];

    try {
      for (const title of invalid)
        expect(() => saveChapter(project, title, head)).toThrow(/invalid chapter title/);
      expect(() => readFileSync(outside, "utf8")).toThrow();
    } finally {
      rmSync(outside, { force: true });
    }
  });

  /*
   * Material lives in a folder of its own, so the interface asks for
   * `资料/年表.md` — and every request failed. `basename(id) === id` is false
   * once there is a separator, so the whole string fell through to the title
   * branch, where the illegal-character set contains the very separator that
   * put it there. Creating material could not succeed in either language, with
   * the folder present or absent.
   *
   * A relative id is a path within the root: each segment is checked, the
   * parent is created, and nothing may climb out.
   */
  test("material can be created inside a folder", () => {
    const project = loadProject(root);
    const head = { id: "h1", blocks: [{ id: "b1", text: "年表。" }], cause: "test" };

    const written = saveChapter(project, "资料/年表.md", head);

    expect(written.ok).toBe(true);
    expect(readFileSync(join(root, "资料", "年表.md"), "utf8")).toBe("年表。\n");
  });

  test("a nested id is still refused when a segment is illegal", () => {
    const project = loadProject(root);
    const head = { id: "h1", blocks: [{ id: "b1", text: "甲。" }], cause: "test" };

    for (const id of ["../外面/年表.md", "资料/../../外面.md", "资料/nul.md", "资料/年表 .md"])
      expect(() => saveChapter(project, id, head)).toThrow(/invalid chapter title/);
  });

  test("blocks carry stable identifiers across a reload", () => {
    writeFileSync(join(root, "01.md"), "甲。\n\n乙。\n");

    const first = loadProject(root).chapters[0]?.head.blocks.map((b) => b.id);
    const second = loadProject(root).chapters[0]?.head.blocks.map((b) => b.id);

    expect(first).toEqual(second!);
  });
});

describe("Verdict Ledger", () => {
  const verdict = (draft: { id?: string; reason?: string; decidedAt?: string } = {}): Verdict => ({
    id: draft.id ?? `v${Math.random()}`,
    proposalId: "p1",
    sliceId: "s1",
    kind: "accept",
    baseline: "rev0",
    decidedAt: draft.decidedAt ?? "2026-07-26T00:00:00.000Z",
    ...(draft.reason === undefined ? {} : { reason: draft.reason }),
  });

  test("a recorded verdict survives reopening the ledger", () => {
    const path = join(root, "ledger.db");
    const written = verdict({ reason: "语气更冷" });

    new VerdictLedger(path).record(written).close();

    const reopened = new VerdictLedger(path);
    expect(reopened.all()).toEqual([written]);
    reopened.close();
  });

  test("legacy baseline ids survive a ledger reopen byte-for-byte", () => {
    const path = join(root, "legacy-ledger.db");
    const baselines = ["h7", "/old/path.md@load", "01.md@1720000000000", "01.md@current"];
    const ledger = new VerdictLedger(path);
    ledger.recordAll(
      baselines.map((baseline, index) => ({
        ...verdict({ id: `legacy-${index}` }),
        baseline,
      })),
    );
    ledger.close();

    const reopened = new VerdictLedger(path);
    expect(reopened.all().map((entry) => entry.baseline)).toEqual(baselines);
    reopened.close();
  });

  test("an unstated reason stays absent rather than becoming an empty string", () => {
    const ledger = new VerdictLedger(join(root, "ledger.db"));
    ledger.record(verdict());

    expect(ledger.all()[0]?.reason).toBeUndefined();
    ledger.close();
  });

  test("verdicts return in decision order", () => {
    const ledger = new VerdictLedger(join(root, "ledger.db"));
    ledger.record(verdict({ id: "b", decidedAt: "2026-07-26T02:00:00.000Z" }));
    ledger.record(verdict({ id: "a", decidedAt: "2026-07-26T01:00:00.000Z" }));

    expect(ledger.all().map((v) => v.id)).toEqual(["a", "b"]);
    ledger.close();
  });

  test("verdicts are searchable by the reasoning the author stated", () => {
    const ledger = new VerdictLedger(join(root, "ledger.db"));
    ledger.record(verdict({ id: "a", reason: "节奏偏慢" }));
    ledger.record(verdict({ id: "b", reason: "语气不对" }));

    expect(ledger.search("节奏").map((v) => v.id)).toEqual(["a"]);
    ledger.close();
  });

  /*
   * `_` and `%` are LIKE's wildcards, and the fragment went in unescaped. The
   * parameter was bound, so nothing could be injected — but the answers were
   * quietly wrong, and this is the entry point to the ledger's whole value.
   * Searching a snake_case term, or a reason containing "30%", returned rows
   * that do not match and the author had no way to notice.
   */
  test("an underscore in the query is a character, not a wildcard", () => {
    const ledger = new VerdictLedger(join(root, "underscore.db"));
    ledger.record(verdict({ id: "a", reason: "改成 snake_case 更一致" }));
    ledger.record(verdict({ id: "b", reason: "snakeXcase 是错的" }));

    expect(ledger.search("snake_case").map((v) => v.id)).toEqual(["a"]);
    ledger.close();
  });

  test("a percent sign in the query is a character, not a wildcard", () => {
    const ledger = new VerdictLedger(join(root, "percent.db"));
    ledger.record(verdict({ id: "a", reason: "这段有 30% 是套话" }));
    ledger.record(verdict({ id: "b", reason: "毫无关系的理由" }));

    expect(ledger.search("30%").map((v) => v.id)).toEqual(["a"]);
    expect(ledger.search("%").map((v) => v.id)).toEqual(["a"]);
    ledger.close();
  });

  test("a backslash in the query does not escape the next character", () => {
    const ledger = new VerdictLedger(join(root, "backslash.db"));
    ledger.record(verdict({ id: "a", reason: "路径写成 C:\\\\书稿 了" }));
    ledger.record(verdict({ id: "b", reason: "另一条" }));

    expect(ledger.search("C:\\\\书稿").map((v) => v.id)).toEqual(["a"]);
    ledger.close();
  });

  test("a duplicate Verdict id cannot rewrite the original audit record", () => {
    const ledger = new VerdictLedger(join(root, "ledger.db"));
    const original = verdict({ id: "fixed", reason: "原来的理由" });
    try {
      ledger.record(original);
      ledger.record({ ...original, kind: "reject", reason: "后来改写" });
      expect(ledger.all()).toEqual([original]);
    } finally {
      ledger.close();
    }
  });

  test("recording the same verdict twice keeps one row", () => {
    const ledger = new VerdictLedger(join(root, "ledger.db"));
    const once = verdict({ id: "fixed" });
    ledger.record(once);
    ledger.record(once);

    expect(ledger.all()).toHaveLength(1);
    ledger.close();
  });
});
