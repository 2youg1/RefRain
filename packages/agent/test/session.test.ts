import { describe, expect, test } from "bun:test";
import {
  canDispatch,
  freeze,
  newSession,
  projectUsage,
  raiseThreshold,
  recordUsage,
  type SessionState,
} from "../src/index.ts";

const session = (over: Partial<SessionState> = {}): SessionState => ({
  ...newSession({ agentId: "a1", capacity: 200_000, threshold: 0.8 }),
  ...over,
});

describe("projected usage decides dispatch, not current usage", () => {
  test("a run that would stay under the threshold is allowed", () => {
    const s = recordUsage(session(), 100_000);

    expect(canDispatch(s, { input: 20_000, maxOutput: 4_000 }).ok).toBe(true);
  });

  test("a run that would cross the threshold is refused before any token is spent", () => {
    const s = recordUsage(session(), 150_000);

    const verdict = canDispatch(s, { input: 20_000, maxOutput: 4_000 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("would-cross-threshold");
  });

  test("the projection states its parts, so an author can check the arithmetic", () => {
    const s = recordUsage(session(), 100_000);
    const projection = projectUsage(s, { input: 20_000, maxOutput: 4_000 });

    expect(projection.current).toBe(100_000);
    expect(projection.input).toBe(20_000);
    expect(projection.maxOutput).toBe(4_000);
    expect(projection.total).toBe(100_000 + 20_000 + 4_000 + projection.margin);
  });
});

describe("freezing is terminal", () => {
  test("a frozen session refuses every further run", () => {
    const s = freeze(session(), "threshold");

    const verdict = canDispatch(s, { input: 10, maxOutput: 10 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("frozen");
  });

  test("raising the threshold does not thaw a frozen session", () => {
    const s = raiseThreshold(freeze(session(), "threshold"), 0.99);

    expect(s.state).toBe("frozen");
    expect(canDispatch(s, { input: 10, maxOutput: 10 }).ok).toBe(false);
  });

  test("the reason a session froze is kept, because it changes what to do next", () => {
    expect(freeze(session(), "threshold").frozenBecause).toBe("threshold");
  });

  test("a session that has not frozen can have its threshold raised", () => {
    const s = raiseThreshold(session(), 0.9);

    expect(s.threshold).toBe(0.9);
    expect(s.state).toBe("active");
  });
});

describe("compaction", () => {
  test("compaction labels lineage unverifiable without freezing the session", () => {
    const s = freeze(recordUsage(session(), 1_000), "compaction");

    expect(s.state).toBe("active");
    expect(canDispatch(s, { input: 10, maxOutput: 10 }).ok).toBe(true);
  });

  test("lineage is unverifiable after compaction, and the session says so", () => {
    expect(freeze(session(), "compaction").lineageVerifiable).toBe(false);
    expect(session().lineageVerifiable).toBe(true);
  });
});

describe("unknown capacity", () => {
  test("a harness that reports no capacity cannot be projected against", () => {
    const s = newSession({ agentId: "a1", capacity: null, threshold: 0.8 });

    const verdict = canDispatch(s, { input: 10_000, maxOutput: 1_000 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("capacity-unknown");
  });
});
