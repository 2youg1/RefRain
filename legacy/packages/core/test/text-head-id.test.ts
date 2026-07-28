import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTextAction, loadProject, newTextHeadId, type TextHead } from "../src/index.ts";

const TEXT_HEAD_ID = /^th:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const seed = (): TextHead => ({
  id: "h7",
  blocks: [{ id: "b1", text: "甲。" }],
  cause: "legacy fixture",
});

const firstActionIdFromFreshRuntime = (): string => {
  const core = new URL("../src/index.ts", import.meta.url).href;
  const program = `
    import { applyTextAction } from ${JSON.stringify(core)};
    const head = applyTextAction(
      { id: "legacy", blocks: [{ id: "b1", text: "甲。" }], cause: "fixture" },
      [{ blockIds: ["b1"], text: "乙。" }],
      "fresh runtime",
    );
    process.stdout.write(head.id);
  `;
  const child = spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
  if (child.status !== 0)
    throw new Error(`fresh Text Action failed (${child.status}): ${child.stderr}`);
  return child.stdout;
};

describe("Text Head identity", () => {
  test("one authority mints opaque UUIDs without process-local reuse", () => {
    const ids = Array.from({ length: 10_000 }, newTextHeadId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => TEXT_HEAD_ID.test(id))).toBe(true);
  });

  test("the first Text Action in two cold runtime graphs cannot reuse an id", () => {
    const first = firstActionIdFromFreshRuntime();
    const second = firstActionIdFromFreshRuntime();

    expect(first).toMatch(TEXT_HEAD_ID);
    expect(second).toMatch(TEXT_HEAD_ID);
    expect(second).not.toBe(first);
  });

  test("range and insertion branches both mint through the authority", () => {
    const range = applyTextAction(seed(), [{ blockIds: ["b1"], text: "乙。" }], "range");
    const insertion = applyTextAction(
      seed(),
      [{ kind: "insert", blockIds: [], blockId: "b2", text: "乙。" }],
      "insertion",
    );

    expect(range.id).toMatch(TEXT_HEAD_ID);
    expect(insertion.id).toMatch(TEXT_HEAD_ID);
    expect(insertion.id).not.toBe(range.id);
  });

  test("reloading the same bytes mints a fresh head but preserves block lineage", () => {
    const root = mkdtempSync(join(tmpdir(), "refrain-head-id-"));
    writeFileSync(join(root, "01.md"), "甲。\n\n乙。\n");

    try {
      const first = loadProject(root).chapters[0]?.head;
      const second = loadProject(root).chapters[0]?.head;
      if (first === undefined || second === undefined) throw new Error("fixture did not load");

      expect(first.id).toMatch(TEXT_HEAD_ID);
      expect(second.id).toMatch(TEXT_HEAD_ID);
      expect(second.id).not.toBe(first.id);
      expect(second.blocks.map((block) => block.id)).toEqual(first.blocks.map((block) => block.id));
      expect(first.id).not.toContain(root);
      expect(second.id).not.toContain("01.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
