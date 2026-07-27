/**
 * The skill in docs/refrain-skill/SKILL.md, checked against the real protocol.
 *
 * The first version of this test only parsed the examples the document happens
 * to contain. That cannot catch the failure that actually occurred: a skill
 * that omits half the protocol parses perfectly, because everything it does
 * say is valid. The document had no <memo> at all — a whole element of the
 * contract, and the one an agent uses to carry anything across a lost context.
 *
 * So the document is now checked against CONTRACT itself, not just against the
 * parser. A skill that falls behind the protocol fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type ArtifactErrorCode, parseAgentResult } from "../../core/src/artifact";

const read = (path: string) => readFileSync(new URL(path, import.meta.url).pathname, "utf8");

const skill = read("../../../docs/refrain-skill/SKILL.md");
const channel = read("../src/file-channel.ts");

/* The contract the application really sends, taken from its own source. */
const contract = /const CONTRACT = `([\s\S]*?)`;/.exec(channel)?.[1];

describe("the skill matches the protocol", () => {
  test("the contract is where this test thinks it is", () => {
    expect(contract).toBeDefined();
    expect(contract).toContain("<agent-result");
  });

  /*
   * Quoting the contract verbatim is the point: a paraphrase drifts silently,
   * and this document exists to be copied from.
   */
  test("the skill quotes the contract verbatim", () => {
    const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(normalise(skill)).toContain(normalise(contract ?? ""));
  });

  /*
   * The omission that motivated this file. Every element the protocol accepts
   * must appear in the document — a skill that never mentions <memo> teaches
   * an agent to throw away the only thing it keeps across a compaction.
   */
  test.each(["agent-result", "replacement", "comments", "comment", "memo"])(
    "the skill documents <%s>",
    (element) => {
      expect(skill).toContain(`<${element}`);
    },
  );

  /* Same argument for the failures an agent can hit. */
  test.each([
    "text-outside-root",
    "duplicate-replacement",
    "missing-scope",
    "unknown-element",
    "unsupported-version",
    "missing-root",
    "dtd-forbidden",
    "too-deep",
    "malformed",
  ] satisfies ArtifactErrorCode[])("the skill explains %s", (code) => {
    expect(skill).toContain(code);
  });
});

describe("the skill's examples parse", () => {
  const blocks = [...skill.matchAll(/```xml\n([\s\S]*?)```/g)]
    .map((m) => m[1]?.trim() ?? "")
    .filter((b) => b.startsWith("<agent-result"));

  test("the document contains agent-result examples", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  test.each(blocks.map((b, i) => [i, b] as const))("example %i", (_i, block) => {
    const result = parseAgentResult(block);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.detail}\n\n${block}`);
    expect(result.ok).toBe(true);
  });

  test("the worked example carries a replacement, a comment and a memo", () => {
    const worked = blocks.find((b) => b.includes("<memo"));
    if (!worked) throw new Error("the skill lost its worked example");

    const result = parseAgentResult(worked);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.detail}`);

    expect(result.value.replacements.length).toBeGreaterThan(0);
    expect(result.value.comments.length).toBeGreaterThan(0);
    expect(result.value.memos.length).toBeGreaterThan(0);
  });

  /*
   * The document states these are fatal. If the parser stopped enforcing one,
   * the skill would be teaching a fear of something harmless.
   */
  test("the rules the skill states are the rules the parser enforces", () => {
    const rejected: [string, string, ArtifactErrorCode][] = [
      [
        "prose outside the root",
        'ok:\n<agent-result version="1"></agent-result>',
        "text-outside-root",
      ],
      [
        "two replacements for one scope",
        '<agent-result version="1"><replacement scope="s1">a</replacement><replacement scope="s1">b</replacement></agent-result>',
        "duplicate-replacement",
      ],
      [
        "an unknown element",
        '<agent-result version="1"><thinking>hm</thinking></agent-result>',
        "unknown-element",
      ],
    ];

    for (const [what, artifact, code] of rejected) {
      const result = parseAgentResult(artifact);
      if (result.ok) throw new Error(`${what} was accepted; the skill calls it fatal`);
      expect(result.error.code, what).toBe(code);
    }
  });
});
