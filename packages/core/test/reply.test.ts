import { describe, expect, test } from "bun:test";
import type { Verdict } from "../src/index.ts";
import { serializeVerdicts } from "../src/index.ts";

interface Draft {
  kind: Verdict["kind"];
  id?: string;
  proposalId?: string;
  sliceId?: string | null;
  finalText?: string;
  reason?: string;
}

/** Optional fields are attached only when present, which `exactOptionalPropertyTypes` requires. */
const v = (draft: Draft): Verdict => ({
  id: draft.id ?? "v1",
  proposalId: draft.proposalId ?? "p1",
  kind: draft.kind,
  baseline: "rev0",
  decidedAt: "2026-07-26T00:00:00.000Z",
  ...(draft.sliceId === null ? {} : { sliceId: draft.sliceId ?? "s1" }),
  ...(draft.finalText === undefined ? {} : { finalText: draft.finalText }),
  ...(draft.reason === undefined ? {} : { reason: draft.reason }),
});

describe("Verdict reply format", () => {
  test("verdicts are numbered in the order the author decided them", () => {
    const xml = serializeVerdicts([
      v({ kind: "reject", sliceId: "s2", reason: "偏离语气" }),
      v({ kind: "accept", sliceId: "s1" }),
    ]);

    expect(xml.indexOf('n="1"')).toBeLessThan(xml.indexOf('n="2"'));
    expect(xml).toContain('n="1" ref="s2"');
  });

  test("accept-modified carries the author's final text", () => {
    const xml = serializeVerdicts([
      v({ kind: "accept-modified", finalText: "剑反而更稳。", reason: "转折更硬" }),
    ]);

    expect(xml).toContain("<final><![CDATA[剑反而更稳。]]></final>");
    expect(xml).toContain("<reason>转折更硬</reason>");
  });

  test("an unstated reason is omitted, never emitted as empty", () => {
    expect(serializeVerdicts([v({ kind: "accept" })])).not.toContain("<reason>");
  });

  test("text closing a CDATA section cannot break out of it", () => {
    const xml = serializeVerdicts([
      v({ kind: "accept-modified", finalText: "他写下 ]]> 然后停笔。" }),
    ]);

    expect(xml).toContain("]]]]><![CDATA[>");
    expect(xml.match(/<final>/g)).toHaveLength(1);
  });

  test("the same verdicts serialize byte-identically, so agent caching hits", () => {
    const verdicts = [v({ kind: "accept" }), v({ kind: "reject", sliceId: "s2" })];

    expect(serializeVerdicts(verdicts)).toBe(serializeVerdicts(verdicts));
  });

  test("a whole-Proposal verdict references the proposal, not a slice", () => {
    const xml = serializeVerdicts([v({ kind: "reject", sliceId: null, proposalId: "p9" })]);

    expect(xml).toContain('ref="p9"');
  });
});
