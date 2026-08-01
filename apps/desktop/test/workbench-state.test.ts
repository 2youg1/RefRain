import { describe, expect, test } from "bun:test";
import {
  initialWorkbenchState,
  reduceWorkbench,
  type WorkbenchState,
} from "../src/shell/workbench-state";

// 「打开到哪一层面板」已经归 PanelStack，那几条规矩在 panel-stack.test.ts。
// 这里只问 reducer 现在真正拥有的两件事：作者在哪个场景，手上有没有稿子。

const selected = (): WorkbenchState =>
  reduceWorkbench(initialWorkbenchState(), { kind: "documentSelected" });

describe("workbench state", () => {
  test("没有文档就进不了逐句裁决与托付", () => {
    const empty = initialWorkbenchState();
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "review" })).toBe(empty);
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "dispatch" })).toBe(empty);
  });

  test("写作现场任何时候都回得去", () => {
    const empty = initialWorkbenchState();
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "writing" }).stage).toBe("writing");
  });

  test("换一份稿子把过期的场景一起清掉", () => {
    const old: WorkbenchState = { hasDocument: true, stage: "review" };
    expect(reduceWorkbench(old, { kind: "documentSelected" })).toEqual(selected());
  });

  test("换项目等于换世界：hasDocument 必须跟着脱钩", () => {
    // 项目变了，旧项目的稿子不再属于这里——hasDocument 留在 true，
    // 逐句裁决与托付就会对着一份不存在的稿子开放。
    const reviewing: WorkbenchState = { hasDocument: true, stage: "review" };
    expect(reduceWorkbench(reviewing, { kind: "projectChanged" })).toEqual(initialWorkbenchState());
  });
});
