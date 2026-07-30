import { describe, expect, test } from "bun:test";
import {
  initialWorkbenchState,
  reduceWorkbench,
  type WorkbenchState,
} from "../src/shell/workbench-state";

// 「打开到哪一层面板」已经归 PanelStack，那几条规矩在 panel-stack.test.ts。
// 这里只问 reducer 现在真正拥有的两件事：作者在哪个场景，有没有待处理的安全事件。

type Conflict = { mine: string; theirs: string };
const selected = (): WorkbenchState<Conflict> =>
  reduceWorkbench(initialWorkbenchState<Conflict>(), { kind: "documentSelected" });

describe("workbench state", () => {
  test("没有文档就进不了 Review 与派发", () => {
    const empty = initialWorkbenchState<Conflict>();
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "review" })).toBe(empty);
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "dispatch" })).toBe(empty);
  });

  test("写作现场任何时候都回得去", () => {
    const empty = initialWorkbenchState<Conflict>();
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "writing" }).stage).toBe("writing");
  });

  test("安全事件盖住交互，但不毁掉作者所在的场景", () => {
    const dispatch = reduceWorkbench(selected(), { kind: "openStage", stage: "dispatch" });
    const conflict = { mine: "mine", theirs: "theirs" };
    const raised = reduceWorkbench(dispatch, { kind: "raiseSafety", value: conflict });
    expect(raised.stage).toBe("dispatch");
    expect(raised.safety?.value).toEqual(conflict);
    // 处理完之后回到原处，而不是被弹去别的地方。
    expect(reduceWorkbench(raised, { kind: "resolveSafety" })).toEqual(dispatch);
  });

  test("换一份稿子把过期的场景与安全事件一起清掉", () => {
    const old: WorkbenchState<Conflict> = {
      hasDocument: true,
      stage: "review",
      safety: { kind: "external-conflict", value: { mine: "a", theirs: "b" } },
    };
    expect(reduceWorkbench(old, { kind: "documentSelected" })).toEqual(selected());
  });
});
