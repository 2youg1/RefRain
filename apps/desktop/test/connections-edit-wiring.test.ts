/**
 * 写作伙伴的编辑与不可达状态的接线。
 *
 * 钉住的失败：编辑做成「删了重建」（id 换了，账本里的参与记录全断）；
 * 或者 NeedsAttention 只剩一颗「重新连接」，作者看不出它以前能用、
 * 上次能用的是哪一版。
 */

import { describe, expect, test } from "bun:test";

describe("伙伴编辑与不可达状态的接线", () => {
  test("编辑走 updateAgent：同一个 id，不是删了重建", async () => {
    const surface = await Bun.file("apps/desktop/src/ui/ConnectionsSurface.tsx").text();
    expect(surface).toContain("编辑");
    expect(surface).toContain("onSave={updateAgent}");
    const session = await Bun.file("apps/desktop/src/shell/connections-session.ts").text();
    expect(session).toContain("commands.updateAgent");
  });

  test("编辑表单预填名字、通道与身份说明", async () => {
    const surface = await Bun.file("apps/desktop/src/ui/ConnectionsSurface.tsx").text();
    expect(surface).toContain("setName(props.agent.name)");
    expect(surface).toContain('setChannel(props.agent.connectionId ?? "")');
    // AgentDto 带 persona 原文：表单预填现有说明；照实说的只剩「清空即删除」。
    expect(surface).toContain('setPersona(props.agent.persona ?? "")');
    expect(surface).toContain("清空后保存将删除它");
  });

  test("不可达状态说得出上次能用的版本", async () => {
    const surface = await Bun.file("apps/desktop/src/ui/ConnectionsSurface.tsx").text();
    expect(surface).toContain("harness.lastKnownVersion");
    expect(surface).toContain("上次可用 v");
    expect(surface).toContain("当前不可达");
    // 重新连接仍在——状态说清楚了，出路不能收走。
    expect(surface).toContain("重新连接");
  });
});
