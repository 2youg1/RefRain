/**
 * 图表围栏的渲染：把 ```mermaid 与 ```nomnoml 画成 SVG。
 *
 * # 为什么是 nomnoml 而不是 Mermaid
 *
 * 实测打包体积（minify + gzip，量的是**打包产物**不是入口文件）：
 *
 * | 库 | gzip | 备注 |
 * |---|---|---|
 * | mermaid | 952 KB | `mermaid.core.mjs` 入口打出来一样大，core 并未按图种拆开 |
 * | @viz-js/viz | 534 KB | 带 WASM |
 * | flowchart.js | 42 KB | 只有流程图 |
 * | **nomnoml** | **26 KB** | 纯 JS 零 WASM |
 *
 * 差 36 倍。而 RefRain 零出网（INV-1），依赖必须整个打进产物——Mermaid 那
 * 952 KB 是每个用户都要下载的常驻成本，不是「用到图表才付」。
 *
 * nomnoml 的零出网已核验：`renderSvg` 产出的 SVG 里所有 URL 都是 XML 命名空间
 * 声明（`http://www.w3.org/2000/svg` 之类），零个 `href`/`src`/`xlink:href`，
 * 不加载任何外部资源。`verify:no-network` 与 `verify:diagram-render` 各守一头。
 *
 * # 为什么还要认 Mermaid 语法
 *
 * 作者的手稿里可能已经写着 ```mermaid——那是事实上的通用语法，换掉它等于
 * 要求作者为了这个编辑器改写自己的稿子。所以下面有一层薄转换：Mermaid 的
 * flowchart 子集译成 nomnoml。
 *
 * 转换覆盖不到的（gantt/class/state/sequence 等）**保留原围栏原样显示**，
 * 一个字节都不吞——看不懂的图表退化成代码块，而不是消失。
 */

import * as nomnoml from "nomnoml";

/** 渲染结果。`kind` 让调用方知道该画 SVG 还是退回原文。 */
export type DiagramResult =
  | { readonly kind: "svg"; readonly svg: string }
  | { readonly kind: "unsupported"; readonly reason: string };

/** 这个围栏语言是不是图表。 */
export function isDiagramLanguage(language: string): boolean {
  const normalised = language.trim().toLowerCase();
  return normalised === "mermaid" || normalised === "nomnoml";
}

/**
 * 把 Mermaid 的 flowchart 子集译成 nomnoml。
 *
 * 只认最常见的那部分——节点、有向边、虚线边、边上的标签。认不出的整行丢弃
 * 而不是猜：猜错会画出一张**看起来对但其实错**的图，比不画更坏。全部行都
 * 认不出时返回 `null`，调用方据此退回原文。
 */
export function mermaidToNomnoml(source: string): string | null {
  const lines = source.split("\n");
  const head = lines[0]?.trim() ?? "";
  // 只处理 flowchart/graph。其余图种（sequenceDiagram/gantt/classDiagram…）
  // 语义差太远，硬译必然失真。
  if (!/^(graph|flowchart)\b/i.test(head)) return null;

  // Mermaid 里同一个节点第一次出现时带标签（`B[编辑视图]`），后续引用只写
  // ID（`B --> C`）。不记住这个映射，后续引用就会画出一个叫「B」的新节点，
  // 图被拆成几条互不相连的短链——实测正是如此：`作者 → 编辑视图` 之后就断了，
  // 而 `B`、`C` 各自成了孤立节点。
  // 两遍扫：Mermaid 不要求先声明后引用，`A --> B` 可以出现在 `B[编辑视图]`
  // 之前。一遍扫会让那种写法里的 B 停在裸 ID 上。
  const labels = new Map<string, string>();
  for (const line of lines.slice(1)) {
    for (const found of line.matchAll(/([^\s[({>|-]+)[[({]([^\])}]*)[\])}]/g)) {
      if (found[1] !== undefined && found[2] !== undefined) labels.set(found[1], found[2]);
    }
  }

  const body: string[] = [];
  for (const line of lines.slice(1)) {
    const text = line.trim();
    if (text === "" || text.startsWith("%%")) continue;

    // `A -->|标签| B` / `A --> B` / `A -.-> B` / `A --- B`
    const edge = /^(\S+?)\s*(-{2,3}>|-\.->|-{3})\s*(?:\|([^|]*)\|\s*)?(\S+)$/.exec(text);
    if (edge) {
      const [, from, arrow, label, to] = edge;
      // `noUncheckedIndexedAccess`：捕获组在类型上是可选的，尽管这个正则里
      // 前两组必然匹配。宁可显式挡掉也不用非空断言。
      if (from === undefined || to === undefined) continue;
      // nomnoml 的虚线是 `-->`，实线是 `->`。Mermaid 恰好相反地用 `-.->` 表虚线。
      const connector = arrow === "-.->" ? "-->" : arrow === "---" ? "-" : "->";
      // 有标签时它夹在连接符与目标节点之间；没有标签时不能留下双空格
      // （`-> ` + ` [` 会得到 `->  [`），nomnoml 虽能忍但输出不该有垃圾。
      const middle = label === undefined || label.trim() === "" ? "" : ` ${label.trim()}`;
      body.push(`[${remember(labels, from)}] ${connector}${middle} [${remember(labels, to)}]`);
      continue;
    }

    // 独立节点声明 `A[标签]`。边里已经出现过的节点不必再声明，但作者可能只
    // 声明不连线。
    const node = /^(\S+?)[[({]([^\])}]*)[\])}]$/.exec(text);
    if (node?.[1] !== undefined && node[2] !== undefined) {
      labels.set(node[1], node[2]);
      body.push(`[${node[2]}]`);
    }
  }

  return body.length === 0 ? null : body.join("\n");
}

/**
 * 画一张图。语法错、图种不支持、库抛异常都退回 `unsupported`，调用方据此
 * 保留原文——图表画不出不该让作者的文字消失。
 */
export function renderDiagram(
  source: string,
  language: string,
  colours: { fill: string; stroke: string; text: string; font: string },
): DiagramResult {
  const normalised = language.trim().toLowerCase();
  let body = source;
  if (normalised === "mermaid") {
    const converted = mermaidToNomnoml(source);
    if (converted === null) {
      return { kind: "unsupported", reason: "这种 Mermaid 图暂时画不了，源码原样保留" };
    }
    body = converted;
  }
  try {
    // 主题指令放在最前面：nomnoml 的 `#` 指令必须先于图元素。
    return { kind: "svg", svg: nomnoml.renderSvg(`${themeDirectives(colours)}\n${body}`) };
  } catch (error) {
    // 库对语法错是抛异常的。让它冒到渲染循环会把整个视图打断，而作者只是
    // 图写到一半。
    return { kind: "unsupported", reason: error instanceof Error ? error.message : "图表语法有误" };
  }
}

/**
 * 解析一个节点记号并记住它的标签。
 *
 * `B[编辑视图]` 记下 B→编辑视图 并返回「编辑视图」；后来的裸 `B` 查表也返回
 * 「编辑视图」，于是两处指的是同一个节点。查不到的裸 ID 原样返回——那是作者
 * 从没给过标签的节点，用 ID 当名字是它唯一可显示的形态。
 */
function remember(labels: Map<string, string>, token: string): string {
  const labelled = /^([^[({]*)[[({]([^\])}]*)[\])}]$/.exec(token);
  if (labelled?.[1] !== undefined && labelled[2] !== undefined) {
    labels.set(labelled[1], labelled[2]);
    return labelled[2];
  }
  return labels.get(token) ?? token;
}

/**
 * 主题指令：让图跟着 RefRain 的七套主题走。
 *
 * 颜色从 CSS 自定义属性读——写死颜色会让图在夜间主题里刺眼，而且那是第二个
 * 配色权威。调用方负责把实际色值解析出来传进来。
 */
export function themeDirectives(colours: {
  readonly fill: string;
  readonly stroke: string;
  readonly text: string;
  readonly font: string;
}): string {
  return [
    `#font: ${colours.font}`,
    `#fill: ${colours.fill}`,
    `#stroke: ${colours.stroke}`,
    `#fontColor: ${colours.text}`,
    "#lineWidth: 1",
    "#padding: 8",
    "#spacing: 30",
    "#edges: rounded",
  ].join("\n");
}
