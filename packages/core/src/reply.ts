import type { Verdict } from "./verdict.ts";
import { cdata, xmlAttribute, xmlText } from "./xml.ts";

/**
 * Serialize verdicts into the reply stream an agent reads (SPEC 7.3).
 *
 * Ordering is the author's decision order and never a map iteration order:
 * a stable prefix is what lets agent-side prompt caching hit across rounds.
 */

export const serializeVerdicts = (verdicts: readonly Verdict[]): string => {
  const entries = verdicts.map((verdict, index) => {
    // The attribute is escaped like everything else here. `reason` and
    // `finalText` always were, and this one was not — the single place where a
    // quote inside an id closes the tag early and the rest of it arrives at the
    // agent as structure. Ids are generated today; an escape that holds only
    // while nobody passes an unusual one is not an escape.
    const lines = [
      `<verdict n="${index + 1}" ref="${xmlAttribute(verdict.sliceId ?? verdict.proposalId)}" kind="${xmlAttribute(verdict.kind)}">`,
    ];
    if (verdict.finalText !== undefined) lines.push(`  <final>${cdata(verdict.finalText)}</final>`);
    if (verdict.reason !== undefined) lines.push(`  <reason>${xmlText(verdict.reason)}</reason>`);
    lines.push("</verdict>");
    return lines.join("\n");
  });

  return `<changes>\n${entries.join("\n")}\n</changes>`;
};
