import { describe, expect, test } from "bun:test";
import * as nomnoml from "nomnoml";

import { isDiagramLanguage, mermaidToNomnoml, themeDirectives } from "../src/diagram-render.ts";

describe("图表围栏识别", () => {
  test("认 mermaid 与 nomnoml，不认其他", () => {
    expect(isDiagramLanguage("mermaid")).toBe(true);
    expect(isDiagramLanguage("nomnoml")).toBe(true);
    expect(isDiagramLanguage("MERMAID")).toBe(true);
    expect(isDiagramLanguage("rust")).toBe(false);
    expect(isDiagramLanguage("")).toBe(false);
  });
});

describe("Mermaid → nomnoml", () => {
  test("有向边", () => {
    const out = mermaidToNomnoml("graph TD\n  A --> B");
    expect(out).toBe("[A] -> [B]");
  });

  test("节点标签取方括号里的文字", () => {
    const out = mermaidToNomnoml("graph TD\n  A[作者] --> B[编辑视图]");
    expect(out).toBe("[作者] -> [编辑视图]");
  });

  test("边上的标签带过去", () => {
    const out = mermaidToNomnoml("graph LR\n  A[提案] -->|人类点击| B[正文]");
    expect(out).toBe("[提案] -> 人类点击 [正文]");
  });

  test("虚线边译成 nomnoml 的虚线——两边符号恰好相反", () => {
    // Mermaid 的 `-.->` 是虚线，nomnoml 的虚线却写作 `-->`。照抄会把虚线画成
    // 实线，图的语义当场反过来。
    const out = mermaidToNomnoml("graph TD\n  A -.-> B");
    expect(out).toBe("[A] --> [B]");
  });

  test("节点 ID 只声明一次，后续引用沿用它的标签", () => {
    // 实测缺陷：Mermaid 里 `B[编辑视图]` 之后可以只写 `B`。不记住这个映射，
    // 后续引用会画出一个叫「B」的新节点，图被拆成几条互不相连的短链
    // ——截图上就是 `作者 → 编辑视图` 之后断掉，`B`、`C` 各自孤立。
    const out = mermaidToNomnoml(
      "graph TD\n  A[作者] --> B[编辑视图]\n  B --> C[裁决账本]\n  C --> D[手稿字节]",
    );
    expect(out).toBe("[作者] -> [编辑视图]\n[编辑视图] -> [裁决账本]\n[裁决账本] -> [手稿字节]");
    // 一条裸 ID 都不该剩下。
    expect(out).not.toMatch(/\[[A-Z]\]/);
  });

  test("标签可以出现在引用之后——两遍扫", () => {
    // Mermaid 不要求先声明后引用。一遍扫会让这里的 B 停在裸 ID 上。
    const out = mermaidToNomnoml("graph TD\n  A --> B\n  B[编辑视图]\n  A[作者]");
    expect(out).toContain("[作者] -> [编辑视图]");
  });

  test("从没给过标签的节点用 ID 当名字", () => {
    // 反向断言：查不到就原样返回，不能变成空节点 `[]`。
    const out = mermaidToNomnoml("graph TD\n  X --> Y");
    expect(out).toBe("[X] -> [Y]");
  });

  test("注释与空行跳过", () => {
    const out = mermaidToNomnoml("graph TD\n  %% 这是注释\n\n  A --> B");
    expect(out).toBe("[A] -> [B]");
  });

  test("非 flowchart 图种返回 null——不硬译", () => {
    // 硬译会画出一张看起来对但其实错的图，比不画更坏。
    expect(mermaidToNomnoml("sequenceDiagram\n  A->>B: 你好")).toBeNull();
    expect(mermaidToNomnoml("gantt\n  title 排期")).toBeNull();
    expect(mermaidToNomnoml("classDiagram\n  Animal <|-- Duck")).toBeNull();
    expect(mermaidToNomnoml("pie title 占比")).toBeNull();
  });

  test("是 flowchart 但一行都认不出时返回 null", () => {
    // 返回空字符串会让调用方画出一张空图。null 才能让它退回原文。
    expect(mermaidToNomnoml("graph TD\n  这行完全不是语法")).toBeNull();
  });

  test("转换结果 nomnoml 真的能吃下去", () => {
    // 这条是整条转换链的意义所在：语法上像 nomnoml 不够，得它真能渲染。
    const converted = mermaidToNomnoml(
      "graph TD\n  A[作者] --> B[编辑视图]\n  B -->|裁决| C[手稿字节]\n  D[Agent] -.-> C",
    );
    expect(converted).not.toBeNull();
    const svg = nomnoml.renderSvg(converted as string);
    expect(svg).toContain("<svg");
    // 四个节点的文字都要出现在 SVG 里。
    for (const label of ["作者", "编辑视图", "手稿字节", "Agent"]) {
      expect(svg).toContain(label);
    }
  });
});

describe("零出网", () => {
  test("SVG 里没有任何外部资源引用", () => {
    // INV-1：应用进程零出网。图表库若在 SVG 里塞 <image href> 或 @import，
    // 那条不变量当场破掉，而且是静默破掉——图会画出来，只是少了点东西。
    const svg = nomnoml.renderSvg(
      `${themeDirectives({ fill: "#f9f3e7", stroke: "#405d89", text: "#19345c", font: "Noto Sans SC" })}\n[作者] -> [编辑视图]`,
    );
    const urls = [...svg.matchAll(/https?:\/\/[^"'\s>]+/g)].map((match) => match[0]);
    // 允许的只有 XML 命名空间声明——它们是标识符，浏览器不会去取。
    const external = urls.filter((url) => !url.startsWith("http://www.w3.org/"));
    expect(external).toEqual([]);
    // 取资源的属性一个都不能有。
    expect(svg).not.toMatch(/\b(?:href|src|xlink:href)\s*=/);
    expect(svg).not.toContain("@import");
    // 断样本数：SVG 里本来就该有命名空间声明，一个 URL 都没匹配到说明
    // 这条测试根本没看到真正的 SVG。
    expect(urls.length).toBeGreaterThan(0);
  });

  test("主题指令进得去且改变输出", () => {
    const plain = nomnoml.renderSvg("[甲] -> [乙]");
    const themed = nomnoml.renderSvg(
      `${themeDirectives({ fill: "#123456", stroke: "#654321", text: "#abcdef", font: "Noto Sans SC" })}\n[甲] -> [乙]`,
    );
    // 反向断言：主题若没生效，两份输出会一模一样。
    expect(themed).not.toBe(plain);
    expect(themed).toContain("#123456");
  });
});
