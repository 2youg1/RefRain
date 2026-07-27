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
import { parseAgentResult } from "../../core/src/artifact";

const skill = readFileSync(new URL("../../../docs/refrain-skill/SKILL.md", import.meta.url).pathname, "utf8");

/* Every fenced xml block in the skill that is an agent reply. */
const blocks = [...skill.matchAll(/```xml\n([\s\S]*?)```/g)]
  .map((m) => m[1].trim())
  .filter((b) => b.startsWith("<agent-result"));

describe("the skill's examples parse", () => {
  test("the document actually contains agent-result examples", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  test.each(blocks.map((b, i) => [i, b] as const))("example %i", (_i, block) => {
    const result = parseAgentResult(block);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}\n\n${block}`);
    expect(result.ok).toBe(true);
  });

  /*
   * The skill's "Five rules" section is only worth writing if the parser
   * enforces it. A rule the parser ignores teaches an agent to fear something
   * harmless; a rule stated but unenforced elsewhere is a gap in the parser.
   */
  test("the rules the skill states are the rules the parser enforces", () => {
    const rejected = {
      "prose outside the root": 'here you go:\n<agent-result version="1"></agent-result>',
      "two replacements for one scope":
        '<agent-result version="1">' +
        '<replacement scope="s1"><![CDATA[a]]></replacement>' +
        '<replacement scope="s1"><![CDATA[b]]></replacement>' +
        "</agent-result>",
      "an unknown element":
        '<agent-result version="1"><thinking>hm</thinking></agent-result>',
    };

    for (const [what, artifact] of Object.entries(rejected)) {
      const result = parseAgentResult(artifact);
      expect(result.ok, `${what} should be rejected`).toBe(false);
    }
  });

  test("the complete example produces the replacement and comment it claims", () => {
    const complete = blocks.find((b) => b.includes("budget and the launch date"));
    expect(complete).toBeDefined();

    const result = parseAgentResult(complete!);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.replacements).toHaveLength(1);
    expect(result.value.replacements[0].scope).toBe("s1");
    expect(result.value.comments).toHaveLength(1);
    expect(result.value.comments[0].target).toBe("s2");
  });
});
