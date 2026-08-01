/**
 * 设置界面的接线。
 *
 * 钉住的失败：一个能力做好了、测试全绿了，而它从来没接到界面上。`findSettings`
 * 就这样悬了整整一版——`settings-tree.test.ts` 的七条测试全绿，而
 * `SettingsSurface` 里「搜索」二字出现 0 次。函数正确与用户拿得到是两件事。
 *
 * `verify:settings-search` 测的是「这个组件能用」，它的夹具直接挂
 * `SettingsSearch`，因此把 `<SettingsSearch>` 从设置界面里整个删掉，那道门禁
 * 照样全绿（实测）。这里补的正是那个缺口。
 *
 * 读源码而不是渲染：挂整个 `SettingsSurface` 要一整套 Tauri 替身，而替身一多
 * 测的就成了替身。「渲染里出现这个标签」是个便宜且不会误判的事实。
 */

import { describe, expect, test } from "bun:test";

const SURFACE = "apps/desktop/src/ui/SettingsSurface.tsx";

describe("设置界面的接线", () => {
  test("搜索接在设置界面上", async () => {
    const source = await Bun.file(SURFACE).text();
    // 导入之外还要有使用。只看 import 会把「导入了但没挂」判成通过
    // ——那正是要抓的那种坏法。
    expect(source).toContain('from "./SettingsSearch"');
    expect(source).toContain("<SettingsSearch");
  });

  test("搜索住在自己的模块里", async () => {
    // `verify:component-depth` 把「第一个 export 的大写函数到文件末尾」当作
    // 组件体。搜索若导出在 SettingsSurface.tsx 里，它之后的一切——包括
    // SettingsSurface 本体——都会被算进组件体，实测从 216 跳到 278。
    // 它本来也该自成一个模块。
    expect(await Bun.file("apps/desktop/src/ui/SettingsSearch.tsx").exists()).toBe(true);
  });

  test("分类由 settings-tree 定义，界面不自己写一份", async () => {
    const source = await Bun.file(SURFACE).text();
    // 这个文件曾经自己写了 `"appearance" | "typography" | "shortcuts"`
    // ——同一份事实的第二个权威，两边漂开时没有任何东西会红。
    expect(source).toContain("SettingsSection");
    expect(source).not.toMatch(/type Section = "appearance" \| "typography" \| "shortcuts"/);
  });
});
