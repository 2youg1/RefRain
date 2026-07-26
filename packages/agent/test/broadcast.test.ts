import { describe, expect, test } from "bun:test";
import { type Agent, broadcast, competitorsFor, type ReviewTask, roundOf } from "../src/index.ts";

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  binding: { harness: "file", model: "unspecified", reasoningEffort: "unspecified" },
});

const task = (over: Partial<ReviewTask> = {}): ReviewTask => ({
  id: "t1",
  agentId: "a1",
  baseline: "rev0",
  prompt: "把这段改得更冷。",
  contextScope: [],
  editScopes: [{ id: "s1", blockIds: ["b2"], text: "声音很熟。" }],
  ...over,
});

describe("broadcasting one request to several agents", () => {
  test("each agent receives its own task over the same scope", () => {
    const round = broadcast(task(), [agent("a1", "kimi"), agent("a2", "codex")]);

    expect(round.tasks).toHaveLength(2);
    expect(round.tasks.map((t) => t.agentId)).toEqual(["a1", "a2"]);
    expect(round.tasks.every((t) => t.editScopes[0]?.id === "s1")).toBe(true);
  });

  test("every task in a round shares one baseline, so the results are comparable", () => {
    const round = broadcast(task({ baseline: "rev7" }), [agent("a1", "k"), agent("a2", "c")]);

    expect(new Set(round.tasks.map((t) => t.baseline))).toEqual(new Set(["rev7"]));
  });

  test("tasks carry distinct identifiers even though the request is identical", () => {
    const round = broadcast(task(), [agent("a1", "k"), agent("a2", "c"), agent("a3", "p")]);

    expect(new Set(round.tasks.map((t) => t.id)).size).toBe(3);
  });

  test("a round records which agents were asked and when", () => {
    const round = broadcast(task(), [agent("a1", "kimi"), agent("a2", "codex")]);

    expect(round.agentIds).toEqual(["a1", "a2"]);
    expect(round.askedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("broadcasting to no agent produces no tasks rather than a malformed round", () => {
    expect(broadcast(task(), []).tasks).toEqual([]);
  });
});

describe("competition", () => {
  test("proposals from one round over one scope are competitors", () => {
    const round = broadcast(task(), [agent("a1", "k"), agent("a2", "c")]);
    const proposals = round.tasks.map((t, i) => ({
      id: `p${i}`,
      runId: `r${i}`,
      baseline: t.baseline,
      scope: { id: t.editScopes[0]?.id ?? "", blockIds: ["b2"] },
      before: "声音很熟。",
      after: `候选 ${i}`,
    }));

    expect(competitorsFor(proposals, proposals[0]?.id ?? "")).toHaveLength(1);
    expect(competitorsFor(proposals, proposals[0]?.id ?? "")[0]?.id).toBe("p1");
  });

  test("a proposal on a different scope is not a competitor", () => {
    const proposals = [
      {
        id: "p0",
        runId: "r0",
        baseline: "rev0",
        scope: { id: "s1", blockIds: ["b2"] },
        before: "甲",
        after: "甲一",
      },
      {
        id: "p1",
        runId: "r1",
        baseline: "rev0",
        scope: { id: "s2", blockIds: ["b3"] },
        before: "乙",
        after: "乙一",
      },
    ];

    expect(competitorsFor(proposals, "p0")).toEqual([]);
  });

  test("merging one competitor leaves the others in place as material", () => {
    const proposals = [
      {
        id: "p0",
        runId: "r0",
        baseline: "rev0",
        scope: { id: "s1", blockIds: ["b2"] },
        before: "甲",
        after: "甲一",
      },
      {
        id: "p1",
        runId: "r1",
        baseline: "rev0",
        scope: { id: "s1", blockIds: ["b2"] },
        before: "甲",
        after: "甲二",
      },
    ];

    // The survivors are whatever the caller did not commit; nothing is deleted
    // by the act of choosing, because a rejected reading is still evidence.
    const survivors = proposals.filter((p) => p.id !== "p0");

    expect(survivors).toHaveLength(1);
    expect(competitorsFor(survivors, "p1")).toEqual([]);
  });
});

describe("rounds", () => {
  test("a proposal reports the round it came from", () => {
    const round = broadcast(task(), [agent("a1", "k"), agent("a2", "c")]);

    expect(roundOf(round, round.tasks[0]?.id ?? "")).toBe(round.id);
    expect(roundOf(round, "not-in-this-round")).toBeUndefined();
  });
});
