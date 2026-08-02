/**
 * 搜索命中的接线。
 *
 * 钉住的失败：`search-hits.test.ts` 的七条断言测的是 `splitOnQuery` 与
 * `excerptAround` 这两个纯函数，它们全绿并不说明作者能在屏幕上看到命中。
 * 把 `<SearchHits>` 从 `Workbench` 里整个删掉，那七条照样全绿——夹具够不到
 * 界面，缺口正在这里。
 *
 * 同一个坏法在这个仓库里发生过一次：`findSettings` 七条单测全绿，而
 * `SettingsSurface` 里「搜索」二字出现 0 次，能力从未到达用户。
 *
 * 读源码而不是渲染：挂整个 `Workbench` 要一整套 Tauri 与编辑器替身，而替身
 * 一多测的就成了替身。「渲染里出现这个标签」是个便宜且不会误判的事实。
 */

import { describe, expect, test } from "bun:test";

const WORKBENCH = "apps/desktop/src/shell/Workbench.tsx";
const SESSION = "apps/desktop/src/shell/project-session.ts";

describe("搜索命中的接线", () => {
  test("命中列表接在工作台上", async () => {
    const source = await Bun.file(WORKBENCH).text();
    // 导入之外还要有使用。只看 import 会把「导入了但没挂」判成通过
    // ——那正是要抓的那种坏法。
    expect(source).toContain('from "../ui/SearchHits"');
    expect(source).toContain("<SearchHits");
  });

  test("命中列表住在自己的模块里", async () => {
    // `verify:component-depth` 把「第一个 export 的大写函数到文件末尾」当作
    // 组件体。命中列表若导出在 Workbench.tsx 里，它之后的一切都会被算进去。
    expect(await Bun.file("apps/desktop/src/ui/SearchHits.tsx").exists()).toBe(true);
    // 纯函数与组件分家：门禁要单独量前者，而组件带 JSX 进不了普通单测。
    expect(await Bun.file("apps/desktop/src/ui/search-excerpt.ts").exists()).toBe(true);
  });

  test("块查询真的发出去了，不是只在类型里存在", async () => {
    const source = await Bun.file(SESSION).text();
    // `blockSearch` 曾经只有类型与桥接，产品路径上零调用——那时搜索面板
    // 拿到的仍然只有一列文件路径。
    expect(source).toContain("commands.blockSearch");
    expect(source).toContain("searchBlocks");
  });

  test("点击命中会跳到那一块，不只是打开文件", async () => {
    const source = await Bun.file(WORKBENCH).text();
    // `BlockHit.ordinal` 一度在 `onSelect` 的签名里存在却被调用点丢掉
    // （写的是 `(path) => props.onSelect(path)`），于是作者落在文首，
    // 还得把刚搜到的那句话再用眼睛找一遍。
    expect(source).toContain("focusBlock");
    // 两处都要钉住。`onSelect={(path, ordinal)` 在这个文件里出现两次——命中
    // 列表把序号交给 RailNav，RailNav 再交给 selectDocument。只写一条通用
    // 正则时，注入掉其中一处另一处仍然匹配，断言全绿（实测如此）。
    expect(source).toContain("onSelect={(path, ordinal) => props.onSelect(path, ordinal)}");
    expect(source).toContain(
      "onSelect={(path, ordinal) => void selectDocument(path, ordinal ?? null)}",
    );
  });

  test("宿主把定位出口透出来了", async () => {
    const host = await Bun.file("apps/desktop/src/ui/EditorHost.tsx").text();
    // 编辑器内核一直有 `focus(blockId, offset)`，宿主没有转出来。
    // 缺这一层时 `EditorHostHandle` 上只有不带参数的 `focus()`。
    expect(host).toContain("focusBlock(blockId: string, offset: number): void");
    expect(host).toContain("focusBlock: (blockId, offset) => editor?.focus(blockId, offset)");
  });
});
