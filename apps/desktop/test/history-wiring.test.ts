/**
 * 历史面板的接线。
 *
 * 钉住的失败：桥上有 listTextActions/revertToAction、领域能选择性回档，
 * 而壳层没有那层面板——作者只能一步步 Ctrl+Z，且每一步都看不见再往前
 * 还有什么。每一行断言对应这条链上的一环；删了哪一环这里都红。
 * 行为验证（真点击、真回档）在 e2e/probe-shell-wiring.ts 的 T7。
 */

import { describe, expect, test } from "bun:test";

describe("历史面板的接线", () => {
  test("栏脚有「历史」入口，开的是 history 这一层 reference", async () => {
    const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
    expect(workbench).toContain("历史");
    expect(workbench).toContain('onOpenHistory: () => openReference({ kind: "history" })');
    expect(workbench).toContain('reference()?.kind === "history"');
  });

  test("history 是 reference 联合的一员，且要有一篇打开的稿子", async () => {
    const state = await Bun.file("apps/desktop/src/shell/workbench-state.ts").text();
    expect(state).toContain('readonly kind: "history"');
    const reference = await Bun.file("apps/desktop/src/shell/panel-reference.ts").text();
    // 穷举 switch：历史与批注、原件同类——没有文档就没有可列的历史。
    expect(reference).toContain('case "history":');
  });

  test("列表与回档归 HistorySession，壳不直接过桥", async () => {
    const session = await Bun.file("apps/desktop/src/shell/history-session.ts").text();
    expect(session).toContain("commands.listTextActions");
    expect(session).toContain("commands.revertToAction");
    const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
    expect(workbench).not.toContain("commands.listTextActions");
    expect(workbench).not.toContain("commands.revertToAction");
    expect(workbench).toContain("createHistoryState(");
  });

  test("回档的落点与 Ctrl+Z 是同一个：宿主 acceptTransition", async () => {
    const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
    expect(workbench).toContain("session.confirmRevert((transition) =>");
    expect(workbench).toContain("current.acceptTransition(transition)");
  });

  test("两类拒绝是会话里的公告措辞，不是组件里的字符串", async () => {
    const session = await Bun.file("apps/desktop/src/shell/history-session.ts").text();
    expect(session).toContain("那一步已不在可撤销的历史里");
    expect(session).toContain("不能越过它回档。");
    const surface = await Bun.file("apps/desktop/src/ui/HistorySurface.tsx").text();
    expect(surface).not.toContain("is not in the undo history");
  });

  test("两步确认与空态诚实都长在面板上", async () => {
    const surface = await Bun.file("apps/desktop/src/ui/HistorySurface.tsx").text();
    // 第一下立确认、说清代价；第二下才执行。
    expect(surface).toContain("将撤销其后");
    expect(surface).toContain("确认回档");
    // 已撤销的行淡出不可点；当前位置标出不可点。
    expect(surface).toContain("已撤销");
    expect(surface).toContain("当前位置");
    // 「已撤回」标记滞后于保存是一句提示，不是警告。
    expect(surface).toContain("「已撤销」标记在下次保存时才会落盘更新。");
    expect(surface).not.toContain("warning");
    // 空态：没有历史就直说。
    expect(surface).toContain("这份文档还没有记录到改动。");
  });
});
