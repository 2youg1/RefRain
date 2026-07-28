import { describe, expect, test } from "bun:test";
import {
  closeRound,
  type DiscussionRound,
  isRoundOver,
  lateArrival,
  openRound,
  settleRun,
} from "../src/index.ts";

const round = (): DiscussionRound =>
  openRound({ agentIds: ["a1", "a2"], prompt: "再冷一点。", baseline: "rev0" });

describe("a round is over when every run reaches a terminal state", () => {
  test("an open round with runs outstanding is not over", () => {
    const r = settleRun(round(), "a1", "completed");

    expect(isRoundOver(r)).toBe(false);
  });

  test("failure and cancellation are terminal, not just success", () => {
    let r = round();
    r = settleRun(r, "a1", "failed");
    r = settleRun(r, "a2", "cancelled");

    expect(isRoundOver(r)).toBe(true);
  });

  test("the author can close a round without waiting for every run", () => {
    const r = closeRound(settleRun(round(), "a1", "completed"));

    expect(isRoundOver(r)).toBe(true);
    expect(r.closedBy).toBe("author");
  });

  test("a round that settled on its own records that it did", () => {
    let r = round();
    r = settleRun(r, "a1", "completed");
    r = settleRun(r, "a2", "completed");

    expect(r.closedBy).toBe("runs-settled");
  });
});

describe("the next round is the author's decision", () => {
  test("closing a round proposes nothing and starts nothing", () => {
    const r = closeRound(round());

    expect(r).not.toHaveProperty("next");
    expect(r.state).toBe("closed");
  });

  test("a new round names its own participants rather than inheriting them", () => {
    const first = closeRound(round());
    const second = openRound({ agentIds: ["a2"], prompt: "再试一次。", baseline: "rev1" });

    expect(second.agentIds).toEqual(["a2"]);
    expect(second.id).not.toBe(first.id);
  });
});

describe("late arrivals", () => {
  test("a run that finishes after the round closed is kept, not discarded", () => {
    const r = lateArrival(closeRound(round()), "a2", "run-late");

    expect(r.late).toEqual([{ agentId: "a2", runId: "run-late" }]);
  });

  test("a late arrival does not reopen the round or enter the next one", () => {
    const r = lateArrival(closeRound(round()), "a2", "run-late");

    expect(r.state).toBe("closed");
  });

  test("a run settling before the close is not a late arrival", () => {
    const r = settleRun(round(), "a1", "completed");

    expect(r.late).toEqual([]);
  });
});

describe("what agents in one round can see", () => {
  test("a round records that participants answer independently", () => {
    expect(round().independent).toBe(true);
  });
});
