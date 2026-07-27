/**
 * The examples in docs/refrain-skill/SKILL.md, run through the real parser.
 *
 * The skill tells an agent what shape to write. A skill whose examples the
 * parser rejects is worse than no skill: it produces confident, invalid files
 * and the author sees nothing at all. So the examples are extracted from the
 * document and parsed, rather than reviewed by eye.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type ArtifactErrorCode, parseAgentResult } from "../../core/src/artifact";

const skill = readFileSync(
  new URL("../../../docs/refrain-skill/SKILL.md", import.meta.url).pathname,
  "utf8",
);

/* Every fenced xml block in the skill that is an agent reply. */
const blocks = [...skill.matchAll(/```xml\n([\s\S]*?)```/g)]
  .map((m) => m[1]?.trim() ?? "")
  .filter((b) => b.startsWith("<agent-result"));

describe("the skill's examples parse", () => {
  test("the document actually contains agent-result examples", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  test.each(blocks.map((b, i) => [i, b] as const))("example %i", (_i, block) => {
    const result = parseAgentResult(block);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.detail}\n\n${block}`);
    expect(result.ok).toBe(true);
  });

  /*
   * The skill's "Five rules" section is only worth writing if the parser
   * enforces it. A rule the parser ignores teaches an agent to fear something
   * harmless; a rule the skill omits but the parser enforces is a trap.
   */
  test("the rules the skill states are the rules the parser enforces", () => {
    const rejected: Record<string, [string, ArtifactErrorCode]> = {
      "prose outside the root": [
        'here you go:\n<agent-result version="1"></agent-result>',
        "text-outside-root",
      ],
      "two replacements for one scope": [
        '<agent-result version="1">' +
          '<replacement scope="s1"><![CDATA[a]]></replacement>' +
          '<replacement scope="s1"><![CDATA[b]]></replacement>' +
          "</agent-result>",
        "duplicate-replacement",
      ],
      "an unknown element": [
        '<agent-result version="1"><thinking>hm</thinking></agent-result>',
        "unknown-element",
      ],
    };

    for (const [what, [artifact, code]] of Object.entries(rejected)) {
      const result = parseAgentResult(artifact);
      if (result.ok) throw new Error(`${what} was accepted; the skill says it is invalid`);
      expect(result.error.code, what).toBe(code);
    }
  });

  test("the complete example produces the replacement and comment it claims", () => {
    const complete = blocks.find((b) => b.includes("budget and the launch date"));
    if (!complete) throw new Error("the skill lost its complete worked example");

    const result = parseAgentResult(complete);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.detail}`);

    expect(result.value.replacements.map((r) => r.scope)).toEqual(["s1"]);
    expect(result.value.comments.map((c) => c.target)).toEqual(["s2"]);
  });
});
