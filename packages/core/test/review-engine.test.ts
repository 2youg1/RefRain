import { describe, expect, test } from "bun:test";
import type { Proposal } from "../src/index.ts";
import { sliceProposal } from "../src/index.ts";

const proposal = (before: string, after: string | null): Proposal => ({
  id: "p1",
  runId: "r1",
  baseline: "rev0",
  scope: { id: "s1", blockIds: ["b2"] },
  before,
  after,
});

describe("Review Slice", () => {
  test("an untouched sentence is context, not a change", () => {
    const slices = sliceProposal(
      proposal("声音很熟。她想起十年前那个雨夜。", "剑没有松。她想起十年前那个雨夜。"),
    );

    expect(slices.filter((s) => s.kind === "same").map((s) => s.text)).toEqual([
      "她想起十年前那个雨夜。",
    ]);
  });

  test("a rewritten sentence becomes a removal paired with an addition", () => {
    const slices = sliceProposal(proposal("声音很熟。", "剑没有松。"));

    expect(slices.map((s) => [s.kind, s.text])).toEqual([
      ["del", "声音很熟。"],
      ["ins", "剑没有松。"],
    ]);
  });

  test("deleting a scope produces removals and no additions", () => {
    const slices = sliceProposal(proposal("声音很熟。剑垂下去。", null));

    expect(slices.every((s) => s.kind === "del")).toBe(true);
    expect(slices).toHaveLength(2);
  });

  test("slice identifiers are stable across repeated slicing", () => {
    const p = proposal("甲。乙。", "甲。丙。");

    expect(sliceProposal(p).map((s) => s.id)).toEqual(sliceProposal(p).map((s) => s.id));
  });
});
