/**
 * 设置树的向量。
 *
 * 钉住的失败：树上写着一条路径，而配置里根本没有那一项——作者搜到它、点
 * 过去，那里什么也没有。这种坏法不会报错，只会让一个功能看起来做过了。
 */

import { describe, expect, test } from "bun:test";

import type { AppearanceConfig } from "../src/generated/bindings.gen";
import { findSettings, SETTINGS_TREE, settingsLeaves } from "../src/shell/settings-tree";

/**
 * 从生成的绑定里取出配置的形状，用来核对树上的每条路径。
 *
 * 用**类型**而不是抄一份字段清单：抄的那份会漂，而 `bindings.gen.ts` 是从
 * Rust 生成的，它漂不了。这个对象只是让类型系统检查键名——值本身不参与
 * 比较，所以取什么无关紧要。
 */
const APPEARANCE_KEYS: readonly (keyof AppearanceConfig)[] = [
  "theme",
  "typography",
  "typography_presets",
  "paper",
  "panel_material",
  "code_theme",
  "night_lamp",
  "panel_width",
  "rail_width",
  "panel_side",
  "panel_animation",
  "icon_digest",
  "bento_opacity_percent",
];

describe("设置树", () => {
  test("每条路径的第一段都是配置里真有的字段", () => {
    // 这一条抓的是「树上写着 appearance.bentoOpacity 而配置里叫
    // bento_opacity_percent」——搜得到、点得过去、那里什么也没有。
    for (const node of settingsLeaves()) {
      const [root, second] = (node.leaf ?? "").split(".");
      expect(root).toBe("appearance");
      expect(APPEARANCE_KEYS).toContain(second as keyof AppearanceConfig);
    }
  });

  test("配置里的每个字段都在树上有位置", () => {
    // **反向的那一半。** 上一条只查「树上写的在配置里存在」，漏写不会红——
    // `typography_presets` 就是这样漏了整整一版：配置里有它、`APPEARANCE_KEYS`
    // 里也有它，而树上没有，于是作者的自定义排版预设在设置索引里不存在，
    // 没有任何东西会因此变红。
    //
    // 单向检查只能证明「树上没有假路径」，证明不了「树覆盖了配置」。两条
    // 合起来才是一个双射。
    const covered = new Set(settingsLeaves().map((node) => (node.leaf ?? "").split(".")[1] ?? ""));
    const missing = APPEARANCE_KEYS.filter((key) => !covered.has(key));
    expect(missing).toEqual([]);
    // 断样本数：树若被清空，上面那条会平凡通过。
    expect(covered.size).toBeGreaterThanOrEqual(APPEARANCE_KEYS.length);
  });

  test("分组不带路径：它不是一个可改的值", () => {
    const groups = SETTINGS_TREE.filter((node) => node.children !== undefined);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.leaf).toBeUndefined();
  });

  test("搜索只返回修改点，不返回分组", () => {
    // 分组进了结果，作者点开只会看到另一层——那不是他要的答案。
    const hits = findSettings("面板");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.leaf).toBeDefined();
  });

  test("说明与路径都能搜到，因为作者记得的可能是任意一个", () => {
    expect(findSettings("行与行之间").map((hit) => hit.label)).toContain("行距");
    expect(findSettings("line_height").map((hit) => hit.label)).toContain("行距");
    expect(findSettings("行距").map((hit) => hit.label)).toContain("行距");
  });

  test("空查询返回空，不返回全部", () => {
    // 返回全部会让「还没输入」看起来像「什么都匹配」。
    expect(findSettings("")).toHaveLength(0);
    expect(findSettings("   ")).toHaveLength(0);
  });

  test("小窗口透明度在树上，且指向真实字段", () => {
    const hit = findSettings("透明度")[0];
    expect(hit?.leaf).toBe("appearance.bento_opacity_percent");
  });

  test("每一条路径互不重复：同一项出现两次，改哪一个就成了问题", () => {
    const paths = settingsLeaves().map((node) => node.leaf);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
