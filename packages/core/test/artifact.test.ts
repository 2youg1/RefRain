import { describe, expect, test } from "bun:test";
import type { ArtifactErrorCode } from "../src/index.ts";
import { parseAgentResult } from "../src/index.ts";

const wrap = (body: string): string => `# Before

原文。

# Request

改写它。

# Agent reply

${body}`;

describe("Result Artifact parsing", () => {
  test("a replacement is bound to its scope", () => {
    const result = parseAgentResult(
      wrap(`<agent-result version="1">
  <replacement scope="s1"><![CDATA[剑没有松。]]></replacement>
</agent-result>`),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacements).toEqual([{ scope: "s1", text: "剑没有松。" }]);
  });

  test("an empty replacement element deletes the scope", () => {
    const result = parseAgentResult(
      wrap(`<agent-result version="1"><replacement scope="s1" /></agent-result>`),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacements).toEqual([{ scope: "s1", text: null }]);
  });

  test("comments survive without manufacturing an empty Proposal", () => {
    const result = parseAgentResult(
      wrap(`<agent-result version="1">
  <comments><comment target="s2"><![CDATA[这段的节奏偏慢。]]></comment></comments>
</agent-result>`),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacements).toHaveLength(0);
    expect(result.value.comments).toEqual([{ target: "s2", text: "这段的节奏偏慢。" }]);
  });

  test("CDATA carrying markup is preserved verbatim", () => {
    const result = parseAgentResult(
      wrap(`<agent-result version="1">
  <replacement scope="s1"><![CDATA[他说「<剑>」，然后 a < b && c > d。]]></replacement>
</agent-result>`),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacements[0]?.text).toBe("他说「<剑>」，然后 a < b && c > d。");
  });
});

describe("Result Artifact rejection", () => {
  const rejects = (name: string, body: string, code: ArtifactErrorCode): void => {
    test(name, () => {
      const result = parseAgentResult(wrap(body));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(code);
    });
  };

  rejects(
    "a DTD is refused before any entity can expand",
    `<!DOCTYPE r [<!ENTITY x "boom">]><agent-result version="1"><replacement scope="s1"><![CDATA[&x;]]></replacement></agent-result>`,
    "dtd-forbidden",
  );

  rejects(
    "an external entity referencing the filesystem is refused",
    `<!DOCTYPE r [<!ENTITY f SYSTEM "file:///etc/passwd">]><agent-result version="1"><replacement scope="s1">&f;</replacement></agent-result>`,
    "dtd-forbidden",
  );

  rejects(
    "two replacements for one scope are ambiguous and refused",
    `<agent-result version="1">
      <replacement scope="s1"><![CDATA[甲]]></replacement>
      <replacement scope="s1"><![CDATA[乙]]></replacement>
    </agent-result>`,
    "duplicate-replacement",
  );

  rejects(
    "an unknown element is refused rather than ignored",
    `<agent-result version="1"><exfiltrate url="http://x" /></agent-result>`,
    "unknown-element",
  );

  rejects(
    "a replacement without a scope has nowhere to land",
    `<agent-result version="1"><replacement><![CDATA[甲]]></replacement></agent-result>`,
    "missing-scope",
  );

  rejects("a missing root element is refused", "just prose, no element at all", "missing-root");

  rejects(
    "an unsupported version is refused",
    `<agent-result version="2"><replacement scope="s1"><![CDATA[甲]]></replacement></agent-result>`,
    "unsupported-version",
  );

  test("prose outside the root element is refused", () => {
    const result = parseAgentResult(
      wrap(`Here is my answer:

<agent-result version="1"><replacement scope="s1"><![CDATA[甲]]></replacement></agent-result>`),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("text-outside-root");
  });

  test("excessive nesting is refused rather than recursed into", () => {
    const deep = "<a>".repeat(200) + "</a>".repeat(200);
    const result = parseAgentResult(
      wrap(
        `<agent-result version="1"><replacement scope="s1">${deep}</replacement></agent-result>`,
      ),
    );

    expect(result.ok).toBe(false);
  });

  /*
   * The one untrusted input this parser exists to survive.
   *
   * A closing tag missing its ">" made `indexOf` return -1, and `-1 + 1` put
   * the cursor back at zero, so the loop rescanned the same element forever and
   * the array grew until the process died. The path is `host.collect()` reading
   * a result file, so any harness emitting one malformed byte took the main
   * process — and every unsaved manuscript in the window — with it.
   *
   * Each of these returns in milliseconds when the guard is present and hangs
   * without it, so the test is written to fail loudly rather than hang the
   * suite: it asserts on the refusal, and a hang is the runner's timeout.
   */
  rejects(
    "a closing tag missing its bracket is refused, not rescanned forever",
    `<agent-result version="1"><memo>x</memo</agent-result>`,
    "malformed",
  );

  // Truncated before the root element closes, so the root regex never matches
  // and the refusal names the missing root rather than the tag inside it. What
  // matters is that it refuses at all: this input used to hang.
  rejects(
    "a reply truncated mid-element is refused",
    `<agent-result version="1"><replacement scope="s1">甲</replacement`,
    "missing-root",
  );

  test("a malformed tag is answered in bounded time", () => {
    const started = Date.now();
    const result = parseAgentResult(wrap(`<agent-result version="1"><memo>x</memo</agent-result>`));
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /*
   * CDATA is consumed as an opaque run, which the module comment has claimed
   * since it was written and `scan()` never did. An agent explaining this very
   * format to its successor — "do not write </replacement> inside prose" — had
   * its whole run refused, and the error pointed at the author's own sentence
   * and called it stray text.
   */
  test("markup inside CDATA never reaches the tag scanner", () => {
    const result = parseAgentResult(
      wrap(
        `<agent-result version="1"><memo><![CDATA[不要在正文里写 </replacement> 这种东西]]></memo></agent-result>`,
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memos[0]?.text).toContain("</replacement>");
  });

  test("a replacement carrying CDATA with angle brackets survives", () => {
    const result = parseAgentResult(
      wrap(
        `<agent-result version="1"><replacement scope="s1"><![CDATA[他写下 <ruby> 标签]]></replacement></agent-result>`,
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacements[0]?.text).toBe("他写下 <ruby> 标签");
  });
});
