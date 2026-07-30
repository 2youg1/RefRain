import { describe, expect, test } from "bun:test";
import {
  initialWorkbenchState,
  reduceWorkbench,
  type WorkbenchState,
} from "../src/shell/workbench-state";

type Conflict = { mine: string; theirs: string };
const selected = (): WorkbenchState<Conflict> =>
  reduceWorkbench(initialWorkbenchState<Conflict>(), { kind: "documentSelected" });

describe("workbench state", () => {
  test("document stages require a document", () => {
    const empty = initialWorkbenchState<Conflict>();
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "review" })).toBe(empty);
    expect(reduceWorkbench(empty, { kind: "openStage", stage: "dispatch" })).toBe(empty);
  });

  test("a reference preserves and restores the current stage", () => {
    const review = reduceWorkbench(selected(), { kind: "openStage", stage: "review" });
    const settings = reduceWorkbench(review, {
      kind: "openReference",
      reference: { kind: "settings", section: "typography" },
    });
    expect(settings.stage).toBe("review");
    expect(reduceWorkbench(settings, { kind: "closeReference" })).toEqual(review);
  });

  test("one reference replaces another without queueing it", () => {
    const settings = reduceWorkbench(selected(), {
      kind: "openReference",
      reference: { kind: "settings", section: "appearance" },
    });
    const connections = reduceWorkbench(settings, {
      kind: "openReference",
      reference: { kind: "connections" },
    });
    expect(connections.reference).toEqual({ kind: "connections" });
  });

  test("safety preempts interaction without destroying stage or reference", () => {
    const dispatch = reduceWorkbench(selected(), { kind: "openStage", stage: "dispatch" });
    const annotated = reduceWorkbench(dispatch, {
      kind: "openReference",
      reference: { kind: "annotations" },
    });
    const conflict = { mine: "mine", theirs: "theirs" };
    const raised = reduceWorkbench(annotated, { kind: "raiseSafety", value: conflict });
    expect(raised.stage).toBe("dispatch");
    expect(raised.reference).toEqual({ kind: "annotations" });
    expect(reduceWorkbench(raised, { kind: "resolveSafety" })).toEqual(annotated);
  });

  test("document selection clears stale stage, reference, and safety", () => {
    const old: WorkbenchState<Conflict> = {
      hasDocument: true,
      stage: "review",
      reference: { kind: "connections" },
      safety: { kind: "external-conflict", value: { mine: "a", theirs: "b" } },
    };
    expect(reduceWorkbench(old, { kind: "documentSelected" })).toEqual(selected());
  });
});
