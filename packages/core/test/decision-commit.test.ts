import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextHead, Verdict } from "../src/index.ts";
import {
  loadWorkspace,
  persistDecisionCommit,
  readChapterFile,
  recoverDecisionCommit,
  replaceFileAtomically,
  serializeChapter,
  VerdictLedger,
  writeChapter,
} from "../src/index.ts";

let root = "";
let stateDir = "";
let chapter = "";
let ledger: VerdictLedger;

const head: TextHead = {
  id: "h1",
  blocks: [{ id: "01:b0", text: "新正文。" }],
  cause: "Decision Batch",
};
const verdict: Verdict = {
  id: "v1",
  proposalId: "p1",
  sliceId: "s1",
  kind: "accept",
  baseline: "h0",
  decidedAt: "2026-07-27T00:00:00.000Z",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refrain-decision-recovery-"));
  stateDir = join(root, ".refrain");
  chapter = join(root, "01.md");
  mkdirSync(stateDir);
  writeFileSync(chapter, "旧正文。\n", "utf8");
  ledger = new VerdictLedger(join(stateDir, "verdicts.db"));
});

afterEach(() => {
  ledger.close();
  rmSync(root, { recursive: true, force: true });
});

const writeIntent = () => {
  const before = readChapterFile(chapter);
  if (!before) throw new Error("missing chapter");
  const after = serializeChapter(head);
  replaceFileAtomically(
    join(stateDir, "decision-commit.json"),
    `${JSON.stringify(
      {
        version: 1,
        path: chapter,
        beforeDigest: before.stamp.digest,
        afterDigest: createHash("sha256").update(after).digest("hex"),
        verdicts: [verdict],
      },
      null,
      2,
    )}\n`,
  );
  return before.stamp;
};

test("recovery before the chapter rename keeps the old manuscript and no Verdict", () => {
  writeIntent();

  expect(recoverDecisionCommit(stateDir, ledger)).toEqual({ ok: true });
  expect(readFileSync(chapter, "utf8")).toBe("旧正文。\n");
  expect(ledger.all()).toEqual([]);
  expect(existsSync(join(stateDir, "decision-commit.json"))).toBe(false);
});

test("recovery after the chapter rename completes the whole ledger batch", () => {
  const before = writeIntent();
  expect(writeChapter(chapter, head, before).ok).toBe(true);

  expect(recoverDecisionCommit(stateDir, ledger)).toEqual({ ok: true });
  expect(readFileSync(chapter, "utf8")).toBe("新正文。\n");
  expect(ledger.all()).toEqual([verdict]);
  expect(existsSync(join(stateDir, "decision-commit.json"))).toBe(false);
});

test("recovery refuses a third manuscript version it cannot attribute", () => {
  writeIntent();
  writeFileSync(chapter, "崩溃后又被别处改过。\n", "utf8");

  const recovery = recoverDecisionCommit(stateDir, ledger);
  expect(recovery.ok).toBe(false);
  expect(readFileSync(chapter, "utf8")).toBe("崩溃后又被别处改过。\n");
  expect(ledger.all()).toEqual([]);
  expect(existsSync(join(stateDir, "decision-commit.json"))).toBe(true);
});

test("recovery attributes the exact BOM, CRLF, and blank-line bytes the chapter writer committed", () => {
  writeFileSync(chapter, "\ufeff甲。\r\n\r\n\r\n乙。\r\n", "utf8");
  const loaded = loadWorkspace([chapter]).chapters[0];
  if (!loaded?.stamp) throw new Error("chapter did not load");
  const edited: TextHead = {
    ...loaded.head,
    blocks: loaded.head.blocks.map((block, index) =>
      index === 1 ? { ...block, text: "乙改。" } : block,
    ),
  };
  const failing = spyOn(ledger, "recordAll").mockImplementation(() => {
    throw new Error("crash before ledger commit");
  });

  expect(() =>
    persistDecisionCommit(stateDir, chapter, loaded.stamp!, edited, [verdict], ledger),
  ).toThrow(/crash before ledger/);
  failing.mockRestore();

  expect(recoverDecisionCommit(stateDir, ledger)).toEqual({ ok: true });
  expect(readFileSync(chapter, "utf8")).toBe("\ufeff甲。\r\n\r\n\r\n乙改。\r\n");
  expect(ledger.all()).toEqual([verdict]);
});
