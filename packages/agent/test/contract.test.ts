import { describe, expect, test } from "bun:test";
import { parseAgentResult } from "@refrain/core";
import { scaffold } from "../src/file-channel.ts";
import type { ReviewTask } from "../src/types.ts";

const task: ReviewTask = {
  id: "t1",
  agentId: "a1",
  baseline: "rev7",
  prompt: "把第二段改短。",
  contextScope: ["ch01"],
  editScopes: [{ id: "s1", blockIds: ["b7"], text: "雾从下游漫上来。" }],
};

/**
 * The contract in the request must match the parser that reads the reply.
 *
 * These two live in different packages and drifted once already: the scaffold
 * documented `<comment scope=…>` while the parser required `<comment target=…>`
 * nested in `<comments>`. Every agent following the instructions would have
 * failed, and the failure would have looked like the agent's fault.
 */
describe("Reply contract", () => {
  test("the example in the request parses", () => {
    const example = `<agent-result version="1">
  <replacement scope="s1">改后的文字</replacement>
  <comments>
    <comment target="s1">这里我拿不准。</comment>
  </comments>
  <memo topic="语气">作者不接受形容词堆叠。</memo>
</agent-result>`;

    const parsed = parseAgentResult(example);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.replacements).toHaveLength(1);
    expect(parsed.value.comments[0]?.target).toBe("s1");
    expect(parsed.value.memos[0]?.topic).toBe("语气");
  });

  test("the scaffold states the contract, not just the element name", () => {
    const text = scaffold(task);

    expect(text).toContain('<agent-result version="1">');
    expect(text).toContain("<replacement scope=");
    expect(text).toContain("target=");
    expect(text).toContain("<memo");
    /* The three failure modes measured against real agent behaviour. */
    expect(text).toContain("code fence");
    expect(text).toContain("preamble");
  });

  test("the scaffold shows every scope id the agent must use", () => {
    const many = {
      ...task,
      editScopes: [...task.editScopes, { id: "s9", blockIds: ["b9"], text: "另一段。" }],
    };

    expect(scaffold(many)).toContain("<!-- scope s9 -->");
  });

  test("a memo is optional", () => {
    const parsed = parseAgentResult(
      `<agent-result version="1"><replacement scope="s1">x</replacement></agent-result>`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.memos).toEqual([]);
  });

  test.failing("an empty memo is omitted rather than spending future context", () => {
    const parsed = parseAgentResult(
      `<agent-result version="1"><memo topic="empty">   </memo></agent-result>`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.memos).toEqual([]);
  });

  test("a memo alone is a valid result: an agent may report without editing", () => {
    const parsed = parseAgentResult(
      `<agent-result version="1"><memo>作者偏好短句。</memo></agent-result>`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.replacements).toEqual([]);
    expect(parsed.value.memos[0]?.text).toBe("作者偏好短句。");
  });

  test("prose outside the root is still refused, as the contract warns", () => {
    const parsed = parseAgentResult(
      `好的，我改好了：<agent-result version="1"><memo>x</memo></agent-result>`,
    );

    expect(parsed.ok).toBe(false);
  });
});
