import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "../src/index.ts";
import { currentText, loadProject, saveChapter, VerdictLedger } from "../src/index.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "recension-"));
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

  test("recording the same verdict twice keeps one row", () => {
    const ledger = new VerdictLedger(join(root, "ledger.db"));
    const once = verdict({ id: "fixed" });
    ledger.record(once);
    ledger.record(once);

    expect(ledger.all()).toHaveLength(1);
    ledger.close();
  });
});
