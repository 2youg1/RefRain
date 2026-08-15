/**
 * 八条 journal 的表本身要满足什么。
 *
 * 表是计划 P1 的落点（「八去处各≥1 条」），所以「八个去处一个不落」这件事
 * 由类型系统（`Record<JournalName, JournalPlan>`）与这里两条断言一起钉住：
 * 去处下标恰好铺满 `workbench.ts` 的去处集合，且文件真的在磁盘上、真的是
 * 一条 journal。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { DESTINATION_COUNT } from "../apps/native/src/workbench.ts";
import { journalNames, journalPath, journalPlans } from "./native-journals.ts";

/** SDK 的 journal 魔数（`session_journal.zig`：`magic "NSDKSJNL"`）。 */
const magic = "NSDKSJNL";

describe("the journal table", () => {
  test("covers every destination exactly once", () => {
    const destinations = journalNames.map((name) => journalPlans[name].destination).sort();
    expect(destinations).toEqual(Array.from({ length: DESTINATION_COUNT }, (_, index) => index));
  });

  test("names each journal after its destination", () => {
    expect(journalNames.length).toBe(DESTINATION_COUNT);
    expect(new Set(journalNames).size).toBe(DESTINATION_COUNT);
  });

  test("every plan drives at least one action and asserts at least one fact", () => {
    for (const name of journalNames) {
      const steps = journalPlans[name].steps;
      expect(steps.some((step) => step.kind === "click" || step.kind === "shortcut")).toBe(true);
      expect(steps.some((step) => step.kind === "expect")).toBe(true);
    }
  });

  test("every pattern is a regex the recorder can compile", () => {
    for (const name of journalNames) {
      for (const step of journalPlans[name].steps) {
        if (step.kind === "expect" || step.kind === "absent") {
          expect(() => new RegExp(step.pattern)).not.toThrow();
        }
      }
    }
  });

  test("a journal that cannot verify its fingerprints says what blocks it", () => {
    for (const name of journalNames) {
      const tier = journalPlans[name].tier;
      if (tier.mode === "no-verify") expect(tier.blockedBy).toMatch(/M8/);
    }
  });
});

describe("the recorded journals", () => {
  test("each one is on disk and is a session journal", () => {
    for (const name of journalNames) {
      const file = journalPath(name);
      expect(statSync(file).size).toBeGreaterThan(magic.length);
      const head = readFileSync(file).subarray(0, magic.length).toString("latin1");
      expect(head).toBe(magic);
    }
  });
});
