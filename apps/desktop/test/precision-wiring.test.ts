/**
 * 精度切换的接线。
 *
 * 钉住的失败：`precision={projectSession.precision}` 是一个不读任何信号的
 * 裸 getter——模式真的切了（搜索行为变了），按钮上的「精确/模糊」与
 * aria-pressed 却永远停在初始值。unit 测试全绿，因为会话那半本来就会切；
 * 断的是显示那一半。行为验证在 e2e/probe-shell-wiring.ts（真点击、真翻转），
 * 这里钉住「显示这半不许再回到裸 getter」。
 */

import { describe, expect, test } from "bun:test";

const WORKBENCH = "apps/desktop/src/shell/Workbench.tsx";

describe("精度切换的接线", () => {
  test("按钮吃的是响应式切片，不是裸 getter", async () => {
    const source = await Bun.file(WORKBENCH).text();
    expect(source).toContain("precision={search().precision}");
    expect(source).toContain("query={search().query}");
    expect(source).not.toContain("precision={projectSession.precision}");
    expect(source).not.toContain("query={projectSession.query}");
  });

  test("响应式切片读 tick，且读到精度", async () => {
    const source = await Bun.file(WORKBENCH).text();
    // trackSearch 是搜索行的唯一响应式切片：命中、查询词、精度。
    // 没了 tick() 那一行，memo 退化成一次性求值——与裸 getter 同一个坏法。
    expect(source).toContain("function trackSearch(");
    expect(source).toContain("precision: session.precision");
    expect(source).toContain("query: session.query");
    expect(source).toContain("hits: session.searchHits");
    expect(source).toContain("const search = trackSearch(projectSession, projectTick);");
  });

  test("按钮的两种读法都跟着 precision 走", async () => {
    const source = await Bun.file(WORKBENCH).text();
    // 标签与 aria-pressed 是同一个事实的两种读法；只钉一个，另一个会漂。
    expect(source).toContain('aria-pressed={props.precision === "loose"}');
    expect(source).toContain('{props.precision === "exact" ? "精确" : "模糊"}');
  });

  test("翻转规则归会话，按钮不自己知道有两态", async () => {
    const workbench = await Bun.file(WORKBENCH).text();
    expect(workbench).toContain("onTogglePrecision={() => projectSession.togglePrecision()}");
    const session = await Bun.file("apps/desktop/src/shell/project-session.ts").text();
    expect(session).toContain("togglePrecision()");
  });
});
