/**
 * 生成「语义断行开/关」的渲染对比页，供所有者裁定。
 *
 * 为什么是脚本而不是手写 HTML：手写的页面无法从一行改动重建，而所有者一旦
 * 在上面拍了板，那个页面就是裁定的载体。这个项目为此付过一次代价——九档主题
 * 预览页没有进仓库，选定七套之后工作区被清理，已批准的色值永久丢失。
 *
 * 页面链接产品真实的 `themes.css` 与 `fonts.css`，不抄色值：抄来的页面
 * 检验的是抄写，不是产品。这也意味着它**按构造无法以单文件打开**——必须从
 * 仓库根起服务。
 *
 * 输出目录由 `REFRAIN_REVIEW_DIR` 决定，默认 `../review/`。仓库内除 LICENSE
 * 外不放 md/html。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  measure,
  optimizedLineStarts,
  semanticLineStarts,
  type TypesetPreset,
  ZH_HANS,
} from "../packages/typeset/src/index.ts";

/**
 * 词首下标（码位坐标系）。与产品同一个写法——增量转换，不是
 * `[...text.slice(0, index)].length`（那是 O(n²)，10000 字 561ms vs 1.07ms）。
 */

/** 四种文体各一段。四段而非一段：增行只在其中两段上出现过。 */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  [
    "叙事",
    "他推开门的时候雪已经停了，院子里那棵老槐树的枝条上积着薄薄一层白，风一吹就簌簌地落下来。她站在台阶上没有回头，只是把围巾又紧了紧。",
  ],
  [
    "学术",
    "排版这件事的难处不在于把字摆整齐，而在于每一次摆放都要同时满足几条互相拉扯的规矩，而它们的优先级从来没有被写在同一张纸上。现代排版系统的困难在于它必须同时服务于阅读者的眼睛与作者的意图。",
  ],
  [
    "技术",
    "该函数接受一个配置对象作为参数，返回一个新的实例。调用方需要自行管理生命周期，在不再使用时显式释放资源，否则会造成内存泄漏。",
  ],
  [
    "专名",
    "北京大学计算机科学技术研究所的研究人员在国际会议上发表了关于自然语言处理的最新研究成果。",
  ],
];

/** 三档版心。em=16 是两处增行发生的那一档，必须在场。 */
const MEASURES = [16, 20, 28] as const;

const wordStartsOf = (text: string): ReadonlySet<number> => {
  const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
  const starts = new Set<number>();
  let utf16 = 0;
  let codePoints = 0;
  for (const piece of segmenter.segment(text)) {
    while (utf16 < piece.index) {
      utf16 += (text.codePointAt(utf16) ?? 0) > 0xffff ? 2 : 1;
      codePoints += 1;
    }
    starts.add(codePoints);
  }
  return starts;
};

/** 把一段文本按给定行首切成行。 */
const linesOf = (text: string, starts: readonly number[]): string[] => {
  const characters = [...text];
  return starts.map((start, index) =>
    characters.slice(start, starts[index + 1] ?? characters.length).join(""),
  );
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);

/**
 * 把切进词中间的那个断点两侧标出来。
 *
 * 标的是**代价**而不是成绩：所有者要看的正是「这一行末尾把一个词切开了」
 * 长什么样，光给一个百分比无法判断它是否要紧。
 */
const renderLine = (
  line: string,
  startIndex: number,
  words: ReadonlySet<number>,
  isLast: boolean,
  gap: number,
): string => {
  const cut = !isLast && !words.has(startIndex + [...line].length);
  const body = escapeHtml(line);
  // 右缘缺口画成一格一格的空位：所有者要判的正是这条边整不整齐，
  // 用一个百分比说不清楚。末行不画——末行短是正常的。
  const slack = isLast ? 0 : Math.round(gap * 2) / 2;
  const shim = slack > 0 ? `<span class="gap" style="--slack:${slack}"></span>` : "";
  return `<div class="line${cut ? " cut" : ""}">${body}${shim}</div>`;
};

/** 每一非末行的右缘缺口（em）。 */
const gapsOf = (text: string, starts: readonly number[], em: number): number[] => {
  const measured = measure(text, ZH_HANS);
  const gaps: number[] = [];
  for (let line = 0; line + 1 < starts.length; line += 1) {
    const from = starts[line] ?? 0;
    const to = starts[line + 1] ?? measured.length;
    let width = 0;
    for (let index = from; index < to; index += 1) {
      const character = measured[index];
      if (character === undefined) continue;
      width +=
        character.spaceBefore +
        (character.kind === "latin" || character.kind === "digit" || character.kind === "space"
          ? 0.5
          : 1);
    }
    gaps.push(em - width);
  }
  return gaps;
};

const panel = (
  text: string,
  preset: TypesetPreset,
  em: number,
  starts: readonly number[],
  words: ReadonlySet<number>,
  title: string,
): string => {
  const lines = linesOf(text, starts);
  const gaps = gapsOf(text, starts, em);
  const rendered = lines
    .map((line, index) =>
      renderLine(line, starts[index] ?? 0, words, index === lines.length - 1, gaps[index] ?? 0),
    )
    .join("");
  const cuts = starts.slice(1).filter((index) => !words.has(index)).length;
  const ragged = gaps.filter((gap) => gap > 0.01).length;
  const worst = Math.max(0, ...gaps);
  return `<div class="panel">
  <div class="panel-head"><span>${title}</span><span class="stat">${lines.length} 行 · 切词 ${cuts} · 参差 ${ragged} · 最大缺口 ${worst.toFixed(1)}字</span></div>
  <div class="page" style="--measure: ${em}em">${rendered}</div>
</div>`;
};

const sections = CORPUS.flatMap(([name, text]) => {
  const measured = measure(text, ZH_HANS);
  const words = wordStartsOf(text);
  return MEASURES.map((em) => {
    const plain = [...optimizedLineStarts(measured, ZH_HANS, em)];
    const semantic = [...semanticLineStarts(measured, ZH_HANS, em, words)];
    const same = JSON.stringify(plain) === JSON.stringify(semantic);
    return `<section>
  <h2>${name} · 版心 ${em}em${same ? '<span class="same">两侧相同</span>' : ""}</h2>
  <div class="pair">
    ${panel(text, ZH_HANS, em, plain, words, "A · 现行")}
    ${panel(text, ZH_HANS, em, semantic, words, "C · 避词")}
  </div>
</section>`;
  });
}).join("\n");

// 汇总数字：与单元测试里钉住的是同一组统计。
let plainCuts = 0;
let semanticCuts = 0;
let totalBreaks = 0;
let plainLines = 0;
let semanticLines = 0;
let plainRagged = 0;
let semanticRagged = 0;
let totalLines = 0;
let plainWorst = 0;
let semanticWorst = 0;
for (const [, text] of CORPUS) {
  const measured = measure(text, ZH_HANS);
  const words = wordStartsOf(text);
  for (const em of [12, 16, 20, 24, 28]) {
    const plain = [...optimizedLineStarts(measured, ZH_HANS, em)];
    const semantic = [...semanticLineStarts(measured, ZH_HANS, em, words)];
    plainLines += plain.length;
    semanticLines += semantic.length;
    plainCuts += plain.slice(1).filter((index) => !words.has(index)).length;
    semanticCuts += semantic.slice(1).filter((index) => !words.has(index)).length;
    totalBreaks += plain.slice(1).length;
    const plainGaps = gapsOf(text, plain, em);
    const semanticGaps = gapsOf(text, semantic, em);
    totalLines += plainGaps.length;
    plainRagged += plainGaps.filter((gap) => gap > 0.01).length;
    semanticRagged += semanticGaps.filter((gap) => gap > 0.01).length;
    plainWorst = Math.max(plainWorst, ...plainGaps);
    semanticWorst = Math.max(semanticWorst, ...semanticGaps);
  }
}

const html = `<!doctype html>
<html lang="zh-Hans">
<meta charset="utf-8">
<title>语义断行对比 · RefRain</title>
<!-- 路径按 apps/desktop/src/main.tsx 的 import 顺序，逐条从代码核实过。
     第一版凭印象写作 styles/fonts.css，那两个文件根本不存在——页面会 200 而
     样式表 404，读起来像「设计做坏了」。 -->
<link rel="stylesheet" href="/apps/desktop/src/app.css">
<link rel="stylesheet" href="/apps/desktop/src/fonts.css">
<link rel="stylesheet" href="/apps/desktop/src/themes.css">
<link rel="stylesheet" href="/apps/desktop/src/styles/surfaces.css">
<style>
  body {
    margin: 0; padding: 3rem 2rem; background: var(--surface, #f6f4ef);
    color: var(--ink, #23201c); font-family: "Noto Sans SC", system-ui, sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 .5rem; }
  .lede { color: var(--ink-muted, #6b6459); max-width: 46em; line-height: 1.8; margin: 0 0 2rem; }
  .summary { display: flex; gap: 2.5rem; flex-wrap: wrap; padding: 1.25rem 1.5rem;
    border: 1px solid var(--rule, #d9d3c7); border-radius: 6px; margin-bottom: 2.5rem; }
  .summary div { line-height: 1.6; }
  .summary b { display: block; font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .summary span { color: var(--ink-muted, #6b6459); font-size: .85rem; }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: .95rem; font-weight: 600; margin: 0 0 .75rem;
       color: var(--ink-muted, #6b6459); display: flex; align-items: center; gap: .75rem; }
  .same { font-size: .75rem; font-weight: 400; padding: .1rem .5rem; border-radius: 3px;
          background: var(--rule, #d9d3c7); color: var(--ink, #23201c); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; align-items: start; }
  .panel { border: 1px solid var(--rule, #d9d3c7); border-radius: 6px; overflow: hidden; }
  .panel-head { display: flex; justify-content: space-between; padding: .5rem .85rem;
    font-size: .8rem; background: var(--surface-raised, #ece7dd); border-bottom: 1px solid var(--rule, #d9d3c7); }
  .stat { color: var(--ink-muted, #6b6459); font-variant-numeric: tabular-nums; }
  .page { padding: 1.1rem .85rem; font-size: 17px; line-height: 1.9; }
  .line { width: var(--measure); white-space: pre; }
  /* 切进词中间的行：行尾下方一道短线。标代价而不是标成绩。 */
  .line.cut { box-shadow: inset 0 -2px 0 -1px var(--refused, #b8563f); }
  /* 右缘缺口：把空出来的那几格画成浅色方块，这条边整不整齐要看得见。 */
  .gap {
    display: inline-block; width: calc(var(--slack) * 1em); height: 1em;
    vertical-align: -0.15em;
    background: repeating-linear-gradient(45deg,
      transparent 0 3px, var(--rule, #d9d3c7) 3px 4px);
    opacity: .85;
  }
</style>
<div class="wrap">
<h1>语义断行 · 开关对比</h1>
<p class="lede">
每一行都是<b>引擎算出的一行</b>，不是浏览器折的——两侧用同一份 <code>measure</code> 结果，
唯一的差别是有没有把词边界作为代价传进去。行尾带红线的那一行，表示它在一个词的中间断开了。
右侧「开」这一档若与左侧完全相同，标题上会写明——那说明避词在那一档要用一行去换，而行数是约束，
所以它退回了左侧的结果。
</p>
<div class="summary">
  <div><b>${((plainCuts / totalBreaks) * 100).toFixed(1)}% → ${((semanticCuts / totalBreaks) * 100).toFixed(1)}%</b><span>断点切进词里（${plainCuts} → ${semanticCuts} 处，共 ${totalBreaks}）</span></div>
  <div><b>${plainRagged} → ${semanticRagged}</b><span>参差的行（共 ${totalLines} 非末行）</span></div>
  <div><b>${plainWorst.toFixed(1)} → ${semanticWorst.toFixed(1)} 字</b><span>最大缺口</span></div>
  <div><b>${plainLines} → ${semanticLines}</b><span>总行数</span></div>
  <div><b>0</b><span>新增依赖</span></div>
</div>
${sections}
</div>
</html>`;

// 与 `generate-layout-preview.ts`、`render-panel-preview.ts` 同一个惯例：
// 产物落在 `docs/`（已 gitignore），脚本进仓库。放 docs/ 而不是仓库外，是因为
// 页面用绝对路径链接产品真实的样式表，服务必须从仓库根起——工件在根之外就
// 取不到，表现是页面 200 而样式全 404，读起来像设计做坏了。
const outputDirectory = process.env.REFRAIN_REVIEW_DIR ?? resolve(import.meta.dir, "../docs");
const target = resolve(outputDirectory, "semantic-break-compare.html");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, html, "utf8");
console.log(target);
