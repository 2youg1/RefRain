import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerdictLedger } from "../src/ledger.ts";

const ledgerAt = (): { ledger: VerdictLedger; home: string } => {
  const home = mkdtempSync(join(tmpdir(), "refrain-kara-"));
  return { ledger: new VerdictLedger(join(home, "ledger.db")), home };
};

/**
 * SPEC Q12. A stray thought caught mid-sentence is a judgment about the work,
 * so it lives in the ledger rather than in a second store of its own.
 *
 * It carries where the author was when it arrived, because the note's whole
 * value is being able to return to that place — a list of thoughts without
 * their positions is a to-do list, which is what this deliberately is not.
 */
test("a note keeps the place the author was standing when it arrived", () => {
  const { ledger, home } = ledgerAt();
  try {
    ledger.note({
      id: "n1",
      text: "查一下 1974 年会议记录的日期",
      chapterId: "03.md",
      blockId: "03.md:b7",
      capturedAt: "2026-07-28T01:00:00.000Z",
    });

    expect(ledger.notes()).toEqual([
      {
        id: "n1",
        text: "查一下 1974 年会议记录的日期",
        chapterId: "03.md",
        blockId: "03.md:b7",
        capturedAt: "2026-07-28T01:00:00.000Z",
      },
    ]);
  } finally {
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});

/** A thought caught with no chapter open is still worth keeping. */
test("a note without a place is accepted rather than refused", () => {
  const { ledger, home } = ledgerAt();
  try {
    ledger.note({ id: "n2", text: "改标题", capturedAt: "2026-07-28T01:05:00.000Z" });
    const [note] = ledger.notes();
    expect(note?.text).toBe("改标题");
    expect(note?.chapterId).toBeUndefined();
    expect(note?.blockId).toBeUndefined();
  } finally {
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("notes come back newest first, because the last thought is the live one", () => {
  const { ledger, home } = ledgerAt();
  try {
    ledger.note({ id: "a", text: "先想到的", capturedAt: "2026-07-28T01:00:00.000Z" });
    ledger.note({ id: "b", text: "后想到的", capturedAt: "2026-07-28T02:00:00.000Z" });
    expect(ledger.notes().map((note) => note.id)).toEqual(["b", "a"]);
  } finally {
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * v0.1.6 offers exactly two things to do with a note: go back to it, or drop
 * it. No priority, no due date, no board — the moment this becomes a task
 * system it competes with the manuscript for the author's attention, which is
 * the problem it was built to remove.
 */
test("a note can be dropped, and dropping an unknown one is not an error", () => {
  const { ledger, home } = ledgerAt();
  try {
    ledger.note({ id: "n3", text: "暂存", capturedAt: "2026-07-28T01:00:00.000Z" });
    expect(ledger.notes()).toHaveLength(1);

    ledger.dropNote("n3");
    expect(ledger.notes()).toEqual([]);

    ledger.dropNote("never-existed");
    expect(ledger.notes()).toEqual([]);
  } finally {
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("notes survive the ledger being closed and reopened", () => {
  const home = mkdtempSync(join(tmpdir(), "refrain-kara-restart-"));
  const path = join(home, "ledger.db");
  try {
    const first = new VerdictLedger(path);
    first.note({ id: "n4", text: "重启也还在", capturedAt: "2026-07-28T01:00:00.000Z" });
    first.close();

    const second = new VerdictLedger(path);
    expect(second.notes().map((note) => note.text)).toEqual(["重启也还在"]);
    second.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Notes and verdicts share a database, not a table: neither may read as the other. */
test("a note is not a Verdict and does not appear among them", () => {
  const { ledger, home } = ledgerAt();
  try {
    ledger.note({ id: "n5", text: "旁念", capturedAt: "2026-07-28T01:00:00.000Z" });
    expect(ledger.all()).toEqual([]);
    expect(ledger.search("旁念")).toEqual([]);
  } finally {
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});
