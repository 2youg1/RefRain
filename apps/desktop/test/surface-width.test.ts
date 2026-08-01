/**
 * 面板与侧栏的宽度：三档，以及「铺满」为什么不是另一个模式。
 */

import { describe, expect, test } from "bun:test";

import { panelWidthPx, railWidthPx } from "../src/shell/surface-width";

describe("宽度三档", () => {
  test("面板窄于常规，常规窄于铺满时的可用宽度", () => {
    expect(panelWidthPx("narrow")).toBeLessThan(panelWidthPx("regular"));
  });

  test("侧栏三档递增，且最窄那档也放得下一个中文章节名", () => {
    const [narrow, regular, wide] = [
      railWidthPx("narrow"),
      railWidthPx("regular"),
      railWidthPx("wide"),
    ];
    expect(narrow).toBeLessThan(regular);
    expect(regular).toBeLessThan(wide);
    // 「第三章　停留」加两级缩进约需 200px；低于这个数就该换一种呈现，
    // 而不是让作者读半个标题。
    expect(narrow).toBeGreaterThanOrEqual(200);
  });

  test("侧栏比面板窄——它只放文件名", () => {
    expect(railWidthPx("wide")).toBeLessThan(panelWidthPx("narrow") + 1);
  });
});
