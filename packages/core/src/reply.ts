import type { Verdict } from "./verdict.ts";
import { cdata, xmlText } from "./xml.ts";

/**
 * Serialize verdicts into the reply stream an agent reads (SPEC 7.3).
 *
 * Ordering is the author's decision order and never a map iteration order:
 * a stable prefix is what lets agent-side prompt caching hit across rounds.
 */

export const serializeVerdicts = (verdicts: readonly Verdict[]): string => {
  const entries = verdicts.map((verdict, index) => {
    const lines = [
      `<verdict n="${index + 1}" ref="${verdict.sliceId ?? verdict.proposalId}" kind="${verdict.kind}">`,
    ];
    if (verdict.finalText !== undefined) lines.push(`  <final>${cdata(verdict.finalText)}</final>`);
    if (verdict.reason !== undefined) lines.push(`  <reason>${xmlText(verdict.reason)}</reason>`);
    lines.push("</verdict>");
    return lines.join("\n");
  });

  return `<changes>\n${entries.join("\n")}\n</changes>`;
};
