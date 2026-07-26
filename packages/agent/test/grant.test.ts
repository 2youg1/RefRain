import { describe, expect, test } from "bun:test";
import { type Grant, grantAllows, issueGrant, revokeGrant, spendGrant } from "../src/index.ts";

const grant = (over: Partial<Grant> = {}): Grant =>
  issueGrant({
    taskId: "t1",
    agentId: "a1",
    sessionId: "s1",
    maxRuns: 3,
    allowedAgentIds: ["a1", "a2"],
    ...over,
  });

describe("what a grant permits", () => {
  test("a run for a declared agent inside the plan is allowed", () => {
    expect(grantAllows(grant(), { agentId: "a2", taskId: "t1" }).ok).toBe(true);
  });

  test("a run for an agent outside the declared set is refused", () => {
    const verdict = grantAllows(grant(), { agentId: "a9", taskId: "t1" });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("agent-not-granted");
  });

  test("a run for a different task is refused: a grant binds to one task", () => {
    const verdict = grantAllows(grant(), { agentId: "a1", taskId: "t2" });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("wrong-task");
  });

  test("an unlimited grant is possible, and states so rather than using a large number", () => {
    const unlimited = grant({ maxRuns: null });

    expect(grantAllows(unlimited, { agentId: "a1", taskId: "t1" }).ok).toBe(true);
    expect(unlimited.maxRuns).toBeNull();
  });
});

describe("spending a grant", () => {
  test("each run consumes one, and the count is visible", () => {
    const spent = spendGrant(spendGrant(grant(), "run1"), "run2");

    expect(spent.spent).toEqual(["run1", "run2"]);
    expect(spent.remaining).toBe(1);
  });

  test("an exhausted grant refuses further runs", () => {
    let g = grant({ maxRuns: 1 });
    g = spendGrant(g, "run1");

    const verdict = grantAllows(g, { agentId: "a1", taskId: "t1" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("exhausted");
  });

  test("an unlimited grant never exhausts", () => {
    let g = grant({ maxRuns: null });
    for (let i = 0; i < 50; i++) g = spendGrant(g, `run${i}`);

    expect(grantAllows(g, { agentId: "a1", taskId: "t1" }).ok).toBe(true);
    expect(g.remaining).toBeNull();
  });

  test("the same run cannot be counted twice", () => {
    const g = spendGrant(spendGrant(grant(), "run1"), "run1");

    expect(g.spent).toEqual(["run1"]);
  });
});

describe("revocation", () => {
  test("a revoked grant refuses everything", () => {
    const verdict = grantAllows(revokeGrant(grant()), { agentId: "a1", taskId: "t1" });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("revoked");
  });

  test("revocation is recorded rather than deleting the grant", () => {
    const revoked = revokeGrant(grant());

    expect(revoked.revokedAt).toBeString();
    expect(revoked.taskId).toBe("t1");
  });
});

describe("what a grant can never permit", () => {
  test("it cannot authorise a merge: no field expresses one", () => {
    const fields = Object.keys(grant());

    for (const forbidden of ["merge", "accept", "commit", "verdict", "autoAccept"])
      expect(fields.some((f) => f.toLowerCase().includes(forbidden))).toBe(false);
  });

  test("it does not survive a change of session", () => {
    const verdict = grantAllows(grant({ sessionId: "s1" }), {
      agentId: "a1",
      taskId: "t1",
      sessionId: "s2",
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("session-changed");
  });
});
