import type { Verdict } from "./verdict.ts";

/**
 * Serialize verdicts into the reply stream an agent reads (SPEC 7.3).
 *
 * Ordering is the author's decision order and never a map iteration order:
 * a stable prefix is what lets agent-side prompt caching hit across rounds.
 */

/**
 * CDATA cannot nest and has no escape character. The standard technique is to
 * close the section, emit the literal `]]>` as text, and reopen — so agent text
 * discussing this very format cannot break out of it.
 */
const cdata = (text: string): string => `<![CDATA[${text.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

const xmlText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
