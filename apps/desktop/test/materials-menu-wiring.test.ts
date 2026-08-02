/**
 * 资料行右键菜单的接线。
 *
 * 钉住的失败：行还在、菜单不出现，或菜单出现了而动的是别的东西
 * （删完名录不刷新、范围写了但下一行没换）。行为无法从 unit 测试看到，
 * 这里把每一环钉在源码上。
 */

import { describe, expect, test } from "bun:test";

describe("资料行右键菜单的接线", () => {
  test("书架认 onContextMenu，菜单措辞照实说（回收站，不是「删除」）", async () => {
    const shelf = await Bun.file("apps/desktop/src/ui/RailShelf.tsx").text();
    expect(shelf).toContain("onContextMenu");
    expect(shelf).toContain("移入回收站");
    expect(shelf).not.toContain("彻底删除");
    // 两步确认：第一下换成确认句，第二下才执行。
    expect(shelf).toContain("确认移入回收站？");
  });

  test("范围是三态单选，null 读作默认值", async () => {
    const shelf = await Bun.file("apps/desktop/src/ui/RailShelf.tsx").text();
    expect(shelf).toContain("menuitemradio");
    expect(shelf).toContain('"outline-only"');
    expect(shelf).toContain('"retrievable"');
    expect(shelf).toContain('"full"');
    // 「从未问过」不是第四个选项：读作枚举默认值 retrievable，与桥另一侧一致。
    expect(shelf).toContain('row.disclosure ?? "retrievable"');
  });

  test("菜单只挂在资料架上，过桥与刷新名录都归 ProjectSession", async () => {
    const workbench = await Bun.file("apps/desktop/src/shell/Workbench.tsx").text();
    expect(workbench).toContain("rowMenu={{");
    expect(workbench).toContain("onRemoveMaterial");
    expect(workbench).toContain("onMaterialDisclosure");
    const session = await Bun.file("apps/desktop/src/shell/project-session.ts").text();
    expect(session).toContain("commands.deleteDocument");
    expect(session).toContain("commands.setDisclosure");
    // 删除后名录真的少了这一行——不是发完命令就当成了。
    expect(session).toContain("#removeRow");
    expect(session).toContain("#replaceRow");
  });

  test("正在编辑的文档移入回收站被禁用，原因写在菜单上", async () => {
    const shelf = await Bun.file("apps/desktop/src/ui/RailShelf.tsx").text();
    // 守卫钉在菜单：这一行与「当前打开的那篇」两个事实只有它同时握着。
    // 文档会话还握着修订号，删掉打开中的文档会被下一次保存原样写回来。
    expect(shelf).toContain("props.currentPath === current().row.path");
    expect(shelf).toContain("disabled={isCurrent()}");
    expect(shelf).toContain("先关闭正在编辑的文档");
  });
});
