/**
 * Ctrl+Z 撤销的接线。
 *
 * 钉住的失败：桥上有 undoEditorAction、编辑器内核在 beforeinput 里拒绝原生
 * historyUndo，而壳层不接这一下按键——作者按 Ctrl+Z 什么也没有发生，且没有
 * 任何测试变红。每一行断言对应这条链上的一环；删了哪一环这里都红。
 */

import { describe, expect, test } from "bun:test";

describe("撤销的接线", () => {
  test("快捷键表认领 Ctrl+Z，并 preventDefault（内核已拒绝原生 historyUndo，两条路不能赛跑）", async () => {
    const shortcuts = await Bun.file("apps/desktop/src/shell/shortcuts.ts").text();
    expect(shortcuts).toContain("readonly undo: () => void;");
    expect(shortcuts).toContain('key === "z"');
    // 原生输入框里的 Ctrl+Z 是浏览器自己的文本撤销，壳层让位。
    expect(shortcuts).toContain('tag === "INPUT"');
    // 没有 redo：Shift+Z 明确不接管，绑一个空键是许诺不存在的能力。
    expect(shortcuts).toContain("!event.shiftKey");
  });

  test("工作台把 undo 交给快捷键表，且只走会话那条路", async () => {
    const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
    expect(workbench).toContain("undo,");
    expect(workbench).toContain("undoWith(documentSession, () => editor)");
    // 壳不直接过桥：undo 的命令归 DocumentSession（名录与修订号的主人）。
    expect(workbench).not.toContain("commands.undoEditorAction");
  });

  test("会话拥有桥命令，且两类拒绝是公告不是失败", async () => {
    const session = await Bun.file("apps/desktop/src/shell/document-session.ts").text();
    expect(session).toContain("commands.undoEditorAction");
    expect(session).toContain("没有可撤销的一步。");
    expect(session).toContain("那一步带着裁决记录，不能撤销。");
  });

  test("宿主把转移落回编辑器：确认修订号、回读、换稿——与结构改动同一条路", async () => {
    const host = await Bun.file("apps/desktop/src/ui/EditorHost.tsx").text();
    expect(host).toContain("acceptTransition(transition: TextTransitionDto): Promise<void>");
    expect(host).toContain("confirmedRevision = transition.revision");
    expect(host).toContain(
      "editor?.replace({ revision: confirmed.revision, blocks: confirmed.blocks })",
    );
  });

  test("快捷键面板说得出这一下", async () => {
    const panel = await Bun.file("apps/desktop/src/ui/ShortcutsPanel.tsx").text();
    expect(panel).toContain('["Ctrl+Z", "撤销一步"]');
    // 不列出 redo：列一个不存在的键是另一种说谎。
    expect(panel).not.toContain("Ctrl+Y");
  });
});
