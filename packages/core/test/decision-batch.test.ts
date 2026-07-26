import { describe, expect, test } from "bun:test";
import type { Proposal, TextHead, Verdict } from "../src/index.ts";
import {
  commitDecisionBatch,
  currentText,
  rebuildReplacement,
  sliceProposal,
} from "../src/index.ts";

const head = (): TextHead => ({
  id: "h0",
  blocks: [
    { id: "b1", text: "黑暗中有人问。" },
    { id: "b2", text: "声音很熟。她想起十年前那个雨夜。" },
    { id: "b3", text: "剑尖垂下去。" },
  ],
  cause: "initial",
});

const onB2: Proposal = {
  id: "p1",
  runId: "run1",
  baseline: "rev0",
  scope: { id: "s-b2", blockIds: ["b2"] },
  before: "声音很熟。她想起十年前那个雨夜。",
  after: "剑没有松。她想起十年前那个雨夜。",
};

const rivalOnB2: Proposal = {
  ...onB2,
  id: "p2",
  runId: "run2",
  after: "这声音她十年没听到了。她想起十年前那个雨夜。",
};

const onB3: Proposal = {
  id: "p3",
  runId: "run3",
  baseline: "rev0",
  scope: { id: "s-b3", blockIds: ["b3"] },
  before: "剑尖垂下去。",
  after: "剑尖没有动。",
};

const verdict = (
  proposal: Proposal,
  sliceId: string,
  kind: Verdict["kind"],
  extra: Partial<Verdict> = {},
): Verdict => ({
  id: `v-${sliceId}`,
  proposalId: proposal.id,
  sliceId,
  kind,
  baseline: proposal.baseline,
  decidedAt: "2026-07-26T00:00:00.000Z",
  ...extra,
});

/** Accept every changed slice of a proposal — the "merge as-is" path. */
const acceptAll = (proposal: Proposal): Verdict[] =>
  sliceProposal(proposal)
    .filter((s) => s.kind !== "same")
    .map((s) => verdict(proposal, s.id, "accept"));

describe("rebuilding a replacement from slice verdicts", () => {
  test("accepting every slice reproduces the agent's text", () => {
    expect(rebuildReplacement(onB2, acceptAll(onB2))).toBe(onB2.after ?? "");
  });

  test("rejecting every slice reproduces the author's original", () => {
    const rejected = sliceProposal(onB2)
      .filter((s) => s.kind !== "same")
      .map((s) => verdict(onB2, s.id, "reject"));

    expect(rebuildReplacement(onB2, rejected)).toBe(onB2.before);
  });

  test("an unjudged slice keeps the original, never the proposal", () => {
    expect(rebuildReplacement(onB2, [])).toBe(onB2.before);
  });

  test("accept-modified uses the author's wording, not the agent's", () => {
    const decided = sliceProposal(onB2)
      .filter((s) => s.kind !== "same")
      .map((s) =>
        s.kind === "ins"
          ? verdict(onB2, s.id, "accept-modified", { finalText: "剑反而更稳。" })
          : verdict(onB2, s.id, "accept"),
      );

    expect(rebuildReplacement(onB2, decided)).toBe("剑反而更稳。她想起十年前那个雨夜。");
  });
});

describe("Decision Batch", () => {
  test.failing("a whole-Proposal accept cannot succeed without changing the manuscript", () => {
    const whole: Verdict = {
      id: "v-whole",
      proposalId: onB2.id,
      kind: "accept",
      baseline: onB2.baseline,
      decidedAt: "2026-07-26T00:00:00.000Z",
    };

    const result = commitDecisionBatch(head(), [onB2], [whole]);
    const changed = result.ok && currentText(result.head) !== currentText(head());

    expect(result.ok === false || changed).toBe(true);
  });

  test("committing one proposal produces a single new Text Head", () => {
    const result = commitDecisionBatch(head(), [onB2], acceptAll(onB2));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentText(result.head)).toBe(
      "黑暗中有人问。\n\n剑没有松。她想起十年前那个雨夜。\n\n剑尖垂下去。",
    );
  });

  test("disjoint proposals commit together as one Text Action", () => {
    const result = commitDecisionBatch(
      head(),
      [onB2, onB3],
      [...acceptAll(onB2), ...acceptAll(onB3)],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentText(result.head)).toContain("剑没有松。");
    expect(currentText(result.head)).toContain("剑尖没有动。");
  });

  test.failing("a Verdict for an unknown Proposal refuses the batch", () => {
    const unknown: Verdict = {
      id: "v-unknown",
      proposalId: "missing",
      kind: "reject",
      baseline: "rev0",
      decidedAt: "2026-07-26T00:00:00.000Z",
    };

    expect(commitDecisionBatch(head(), [onB2], [unknown]).ok).toBe(false);
  });

  test.failing("opposite Verdicts on one Review Slice refuse hidden last-write-wins", () => {
    const slice = sliceProposal(onB2).find((entry) => entry.kind !== "same")!;
    const result = commitDecisionBatch(
      head(),
      [onB2],
      [
        verdict(onB2, slice.id, "accept"),
        { ...verdict(onB2, slice.id, "reject"), id: "v-opposite" },
      ],
    );

    expect(result.ok).toBe(false);
  });

  test.failing("accept-modified without finalText refuses the batch", () => {
    const slice = sliceProposal(onB2).find((entry) => entry.kind === "ins")!;

    expect(
      commitDecisionBatch(head(), [onB2], [verdict(onB2, slice.id, "accept-modified")]).ok,
    ).toBe(false);
  });

  test("competing proposals on one scope refuse the batch rather than picking a winner", () => {
    const result = commitDecisionBatch(
      head(),
      [onB2, rivalOnB2],
      [...acceptAll(onB2), ...acceptAll(rivalOnB2)],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("overlapping-scopes");
    expect(result.detail.join(" ")).toContain("b2");
  });

  test("a batch refused for conflict leaves the manuscript untouched", () => {
    const before = head();
    commitDecisionBatch(before, [onB2, rivalOnB2], [...acceptAll(onB2), ...acceptAll(rivalOnB2)]);

    expect(currentText(before)).toBe(currentText(head()));
  });

  test("choosing one competitor commits it and leaves the other unapplied", () => {
    const result = commitDecisionBatch(head(), [onB2, rivalOnB2], acceptAll(rivalOnB2));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentText(result.head)).toContain("这声音她十年没听到了。");
    expect(currentText(result.head)).not.toContain("剑没有松。");
  });

  test("a proposal whose before-text has drifted is refused, not force-applied", () => {
    const drifted: TextHead = {
      ...head(),
      blocks: [
        { id: "b1", text: "黑暗中有人问。" },
        { id: "b2", text: "声音很熟。作者后来改过这句。" },
        { id: "b3", text: "剑尖垂下去。" },
      ],
    };

    const result = commitDecisionBatch(drifted, [onB2], acceptAll(onB2));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stale-baseline");
  });

  test("an empty batch is a no-op rather than an empty commit", () => {
    const result = commitDecisionBatch(head(), [onB2], []);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing-staged");
  });

  test("rejections enter the audit record without changing the manuscript", () => {
    const rejections = sliceProposal(onB2)
      .filter((s) => s.kind !== "same")
      .map((s) => verdict(onB2, s.id, "reject", { reason: "偏离既定语气" }));

    const result = commitDecisionBatch(head(), [onB2], rejections);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentText(result.head)).toBe(currentText(head()));
    expect(result.verdicts).toHaveLength(rejections.length);
  });

  test("disjoint proposals commute", () => {
    const forward = commitDecisionBatch(
      head(),
      [onB2, onB3],
      [...acceptAll(onB2), ...acceptAll(onB3)],
    );
    const reverse = commitDecisionBatch(
      head(),
      [onB3, onB2],
      [...acceptAll(onB3), ...acceptAll(onB2)],
    );

    expect(forward.ok && reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;
    expect(currentText(forward.head)).toBe(currentText(reverse.head));
  });
});
