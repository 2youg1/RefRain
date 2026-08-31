// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * 八条 journal 的表本身要满足什么。
 *
 * 表是计划 P1 的落点（「八去处各≥1 条」），所以「八个去处一个不落」这件事
 * 由类型系统（`Record<JournalName, JournalPlan>`）与这里两条断言一起钉住：
 * 去处下标恰好铺满去处集合，且文件真的在磁盘上、真的是一条 journal。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { journalNames, journalPath, journalPlans } from "./native-journals.ts";

/** SDK 的 journal 魔数（`session_journal.zig`：`magic "NSDKSJNL"`）。 */
const magic = "NSDKSJNL";

/**
 * 去处有几个——从唯一的权威里数出来。
 *
 * 单元 13 之前这个数字从 `workbench.ts` 导入；那个模块随 TypeScript 车道一起死了，
 * 而去处的权威现在是 `core/workbench.zig` 的 `Destination` 枚举。Bun 进不了 Zig，
 * 所以这里读那份源码数枚举项——**不是写死一个 8**：写死的数字在新增一个去处时
 * 不会红，而这条测试存在的全部理由就是那一刻要红。
 */
function destinationCount(): number {
  const source = readFileSync("apps/native/src/core/workbench.zig", "utf8");
  const body = source.match(/pub const Destination = enum\(u3\) \{([\s\S]*?)\n\n/)?.[1];
  if (body === undefined)
    throw new Error("core/workbench.zig: 读不出 Destination 枚举；这条测试失去了它的权威");
  // 枚举项写的是 `manuscript = 0,`（显式序号），也允许不带序号的写法。
  const names = body.match(/^ {4}[a-z_]+(?: *= *\d+)?,$/gm) ?? [];
  if (names.length === 0) throw new Error("core/workbench.zig: Destination 枚举里数不出项");
  return names.length;
}

const DESTINATION_COUNT = destinationCount();

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
