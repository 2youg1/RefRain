#!/usr/bin/env bun
/**
 * 门禁：同一份手稿的断行位置在三个平台上逐行相同。
 *
 * ## 判据是双向的，缺一不可（Plan 第四章）
 *
 * ① 同一份中英混排手稿在 Linux 与 Windows 渲染后**断行位置逐行相同**；
 * ② **关掉自研改用纯引擎能力时两端出现可见差异**。
 *
 * 第二条是反向判据，比第一条更重要：没有它，一个「什么都不做」的排版层也能
 * 让两端完全一致——那时门禁测的是浏览器，不是我们的代码。
 *
 * ## 怎么在没有 Windows 机器的情况下守住跨平台
 *
 * 不需要 Windows 机器。断行是**纯几何计算**：`packages/typeset` 零依赖零 DOM，
 * 输入是字符串加预设，输出是数字。同一份输入在任何平台上都该得到同一份输出，
 * 除非有人写进了平台相关的东西（`process.platform` 分支、依赖字体度量、依赖
 * 浏览器 API）。
 *
 * 所以做法是**把断行结果冻成一份指纹提交进仓库**，三个平台各自复算并比对。
 * CI 的 `gate.yml` 是 linux/windows/macos 三平台矩阵、跑同一条 `bun run gate`，
 * 于是这道门禁在 Windows 上跑的时候，它比对的正是 Linux 上冻下来的那份。
 * **指纹不符就是平台差异**，而它会指出具体是哪一段、哪一行、差在第几个字符。
 *
 * 这比「本地渲染一次、CI 渲染一次、人去对比截图」强的地方在于：差异发生时
 * 有人会被门禁拦住，而不是等到某位读者说「我这儿看着不一样」。
 *
 * ## 为什么指纹够用，不必真开三个浏览器
 *
 * 排版管线里只有最后一步「画到屏幕上」需要真引擎，前面八步全是算术。
 * 真引擎那一层由 `verify:inter-script-spacing` 在 Chromium 里量真实像素守着
 * （WebView2 内核即 Chromium，与 Windows 生产同源）。两道门禁分工不同：
 * 那道问「画出来对不对」，这道问「三个平台算出来一不一样」。
 *
 * ## 注入验红（实测记录，含一条查明为不可观测的）
 *
 * | 注入 | 结果 |
 * |---|---|
 * | 改任一预设的数值 | 红：指出哪份语料哪个版心的断点变了、差在第几个字符 |
 * | `lineEndAdjustment` 恒返回 0 | 红：指纹不符 |
 * | 任一自研规则改成空操作 | 红：反向判据报出是哪一条没有贡献 |
 * | `ACCEPTABLE_PENALTY` 20 → 10 | **不红，且查明不可能红** |
 *
 * 最后一条如实记下来。`penaltyAt` 的值域实测只有四个点：0（表意文字之间）、
 * 1（宽松档的长标点与中点）、10（其余跨类边界）、40（非宽松档的长标点）。
 * 阈值 20 落在 10 与 40 之间的空隙里——**改成 11 到 39 之间任何一个值，
 * 断行行为完全相同**。没有任何语料能把它们区分开，因为区分它们需要一个
 * 代价落在两者之间的候选断点，而那样的候选不存在。
 *
 * 所以这不是「语料不够好」，是那条常量在当前值域下没有可观测后果。真要让它
 * 可观测，得先让 `penaltyAt` 产生更细的代价分级——那是排版设计问题，不是
 * 门禁问题。**一条没被证明能红的断言，就是一条还不知道有没有用的断言**，
 * 而这里的诚实做法是记下它测不到什么，不是伪造一个能红的注入。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  candidates,
  JA,
  lineEndAdjustment,
  lineStarts,
  measure,
  optimizedLineStarts,
  presetOf,
  widthEm,
  ZH_HANS,
  ZH_HANT,
} from "../packages/typeset/src/index.ts";

const FINGERPRINT = "packages/typeset/test/layout-fingerprint.json";

/**
 * 语料按「跨平台最容易分歧的那几类」造。
 *
 * 中西相邻（间距）、连续标点（挤压）、行尾标点（两地规矩相反）、长不可断
 * 跨度（触发局部最优）、代理对与 emoji（UTF-16 与码位的差别，最容易在不同
 * 运行时上表现不同）。
 *
 * **最后两份是为「代价阈值」造的**，它们的存在有一段实测教训：第一版语料
 * 的候选断点代价只有 0、10、40 三种值，没有任何一个落在 10 与 20 之间，
 * 于是把 `ACCEPTABLE_PENALTY` 从 20 改到 10 时**指纹逐字节不变**——那条常量
 * 决定「代价多高就宁可往前退」，是断行的核心参数之一，而门禁对它完全不敏感。
 *
 * 含 `……` 与 `・` 的句子在宽松档下产生代价 1 的断点、在标准与严格档下产生
 * 代价 40 的断点，这才把阈值两侧都覆盖上。**语料「看起来有区分特征」不等于
 * 「量得出差异」，要按规则里真正被判定的那几个字符类造。**
 */
const CORPORA: readonly (readonly [string, string])[] = [
  ["中英混排", "他在Notebook上写下42，改成forty-two，最后写回汉字。"],
  ["连续标点", "他说：「这件事，我想过很久了。」——然后沉默……"],
  ["行尾标点", "今日は晴天です。明日も晴れるでしょう。"],
  ["长跨度", "使用 Knuth-Plass 算法时，feasible breakpoint 的密度远高于拉丁文。"],
  ["URL", "参见 https://www.w3.org/TR/clreq/#line-breaking-rules 的说明。"],
  ["代理对", "他说🙂然后走了，𠀋 是增补平面汉字，测试 UTF-16 边界。"],
  ["纯中文", "排版的目的不是把字放进版心，而是让读者的眼睛在换行时不必重新寻找位置。"],
  ["长标点", "彼は言った……そして・止まった。「本当ですか？！」"],
  ["省略号密集", "他想说什么……可是又停住了……最后什么也没说。"],
];

const PRESETS = [
  ["zh-hans", ZH_HANS],
  ["zh-hant", ZH_HANT],
  ["ja", JA],
] as const;

/** 三档严格度都要进指纹：阈值只在某些档上才被读到。 */
const STRICTNESS = ["loose", "normal", "strict"] as const;

/**
 * 版心取样。
 *
 * 28 与 30 是后补的：局部最优只在「不可断跨度接近版心宽度」时才与贪心不同解，
 * URL 那份语料的分歧窗口实测在 30–31em，而第一版取样 24 之后直接跳到 32，
 * **正好跨过了它**。反向判据于是报告「局部最优在全部语料上都没改变任何结果」
 * ——那不是代码没生效，是取样漏掉了它生效的那一档。
 *
 * 25 与 26 是第二次后补，同一个坑第二次踩：ASCII 标点的宽度从全角改成半角
 * （`isHalfWidth`，见 `spacing.ts`）之后，URL 那段的墨宽整体变窄，分歧窗口
 * 跟着从 30–31em **移到了 25–26em**，取样又一次正好跨过。扫 6–60em 全档实测
 * 只有 URL/25、URL/26 两处 DP 与贪心不同解。
 *
 * 教训不是「再补两个值」，而是：**这个反向判据的取样必须跟着宽度模型走**。
 * 任何改动字符宽度的修改都会平移分歧窗口，而窗口很窄（两三 em）。所以下面
 * 那条断言在报错时要指出「扫全档找新窗口」，不要让人误以为规则失效了。
 *
 * 这与语料的教训是同一条：分档断言要**扫多个值找临界点**，取样太疏时
 * 「量不到」与「没实现」的输出完全相同。
 */
const MEASURES = [12, 16, 20, 24, 25, 26, 28, 30, 32, 40] as const;

/** 一份完全确定的断行读数。任何平台上算出来都该逐字节相同。 */
function computeLayout(): Record<string, unknown> {
  const layout: Record<string, unknown> = {};
  for (const [corpusName, text] of CORPORA) {
    for (const [presetName, preset] of PRESETS) {
      const measured = measure(text, preset);
      const perMeasure: Record<string, unknown> = {};
      for (const em of MEASURES) {
        for (const strictness of STRICTNESS) {
          perMeasure[`${em}/${strictness}`] = {
            greedy: [...lineStarts(measured, preset, em, strictness)],
            optimized: [...optimizedLineStarts(measured, preset, em, strictness)],
          };
        }
      }
      layout[`${corpusName}/${presetName}`] = {
        width: widthEm(measured),
        spacing: measured.map((character) => character.spaceBefore),
        candidates: Object.fromEntries(
          STRICTNESS.map((strictness) => [
            strictness,
            candidates(measured, preset, strictness).map((entry) => [entry.index, entry.penalty]),
          ]),
        ),
        lineEnd: measured.map((character) => lineEndAdjustment(character.kind, preset)),
        lines: perMeasure,
      };
    }
  }
  return layout;
}

const failures: string[] = [];
const layout = computeLayout();

/**
 * 指纹按**单行紧凑 JSON** 落盘，不用缩进。
 *
 * 第一版写的是 `JSON.stringify(layout, null, 2)`，全套门禁当场变红：
 * `bun run fmt`（biome）会把这份 JSON 重新格式化——把 `[0, 0, 0.125, …]`
 * 折成每个元素一行，文件从 88,887 字节涨到 177,861，于是下一次比对必然不符。
 *
 * 这不是断行变了，是**指纹被格式化工具改写了**。一份用来做逐字节比对的
 * 基线，不能同时是格式化工具的作用对象——两者对同一个文件各有主张时，
 * 门禁会在没有任何人改动排版的情况下反复变红。
 *
 * 紧凑单行没有可供 biome 调整的空白，所以它对格式化免疫。
 * 代价是文件不便人读，而那正合适：**它本来就不是给人读的**，
 * 差异由门禁负责定位到具体是哪一组、第几个字符。
 */
const serialized = `${JSON.stringify(layout)}\n`;

if (!existsSync(FINGERPRINT)) {
  writeFileSync(FINGERPRINT, serialized);
  console.log(`PASS  verify:layout-parity  (指纹首次生成，${Object.keys(layout).length} 组)`);
  process.exit(0);
}

const frozen = readFileSync(FINGERPRINT, "utf8");
if (frozen !== serialized) {
  // 报出第一处差异的位置与两侧原文——「不相等」本身没有诊断价值。
  const frozenLayout = JSON.parse(frozen) as Record<string, unknown>;
  const keys = new Set([...Object.keys(frozenLayout), ...Object.keys(layout)]);
  for (const key of keys) {
    const before = JSON.stringify(frozenLayout[key]);
    const after = JSON.stringify(layout[key]);
    if (before === after) continue;
    let column = 0;
    while (column < Math.min(before?.length ?? 0, after?.length ?? 0)) {
      if (before?.[column] !== after?.[column]) break;
      column += 1;
    }
    failures.push(
      `「${key}」的断行读数与冻结指纹不符（第 ${column} 个字符起）\n` +
        `      冻结: …${before?.slice(Math.max(0, column - 40), column + 40)}…\n` +
        `      本机: …${after?.slice(Math.max(0, column - 40), column + 40)}…`,
    );
  }
  if (failures.length === 0) {
    failures.push("指纹字节不同但逐组比对全部相同——序列化本身不稳定，这比断行变了更糟");
  }
}

/**
 * 反向判据：自研排版必须真的在改变断行，否则这道门禁测的是浏览器。
 *
 * 第一版这里只对照「朴素等宽折行」，而它太弱：把 `lineEndAdjustment` 整个
 * 改成 `return 0`（即关掉行尾挤压这条自研规则）之后，反向判据**照常全绿**，
 * 因为禁则与不可断跨度仍然让断行与等宽折行不同。也就是说它证明的是「自研
 * 里还剩下点什么」，而不是「每一条自研规则都在生效」。
 *
 * 改成**逐条**问：每一条自研规则单独关掉时，都必须有语料上出现可见差异。
 * 这样任何一条被改成空操作，对应那一行立刻变红，而不是被其余几条掩护过去。
 */
const contributions = new Map<string, number>([
  ["行尾挤压", 0],
  ["混排间距", 0],
  ["禁则与不可断", 0],
  ["局部最优", 0],
]);

for (const [, text] of CORPORA) {
  const measured = measure(text, ZH_HANS);

  // 行尾挤压：把行尾调整置零后断点是否变化。
  for (const em of MEASURES) {
    const withAdjustment = JSON.stringify([...lineStarts(measured, ZH_HANS, em)]);
    const withoutAdjustment = JSON.stringify([
      ...lineStarts(
        measured.map((character) =>
          character.kind === "stop" || character.kind === "close"
            ? { ...character, kind: "ideograph" as const }
            : character,
        ),
        ZH_HANS,
        em,
      ),
    ]);
    if (withAdjustment !== withoutAdjustment) {
      contributions.set("行尾挤压", (contributions.get("行尾挤压") ?? 0) + 1);
      break;
    }
  }

  // 混排间距：把 spaceBefore 归零后行宽是否变化。
  const spacedWidth = widthEm(measured);
  const flatWidth = widthEm(measured.map((character) => ({ ...character, spaceBefore: 0 })));
  if (spacedWidth !== flatWidth) {
    contributions.set("混排间距", (contributions.get("混排间距") ?? 0) + 1);
  }

  // 禁则与不可断：候选断点必须真的少于「处处可断」。
  if (candidates(measured, ZH_HANS).length < measured.length - 1) {
    contributions.set("禁则与不可断", (contributions.get("禁则与不可断") ?? 0) + 1);
  }

  // 局部最优：跨度触发时它必须给出与贪心不同的解。
  for (const em of MEASURES) {
    if (
      JSON.stringify([...optimizedLineStarts(measured, ZH_HANS, em)]) !==
      JSON.stringify([...lineStarts(measured, ZH_HANS, em)])
    ) {
      contributions.set("局部最优", (contributions.get("局部最优") ?? 0) + 1);
      break;
    }
  }
}

for (const [rule, count] of contributions) {
  if (count === 0) {
    failures.push(
      `自研规则「${rule}」在全部 ${CORPORA.length} 份语料上都没有改变任何结果。\n` +
        "      它要么已被改成空操作，要么**取样漏掉了它生效的那一档**。\n" +
        "      先查后者：分歧窗口只有两三 em 宽，且会随字符宽度模型平移。\n" +
        "      扫全档找它，再把命中的 em 补进 MEASURES：\n" +
        "        for (let em = 6; em <= 60; em++) 比较 optimizedLineStarts 与 lineStarts\n" +
        "      两次红都是这个原因（30→31em、改半角宽度后移到 25→26em），\n" +
        "      至今没有一次是规则真的失效。",
    );
  }
}
const divergent = [...contributions.values()].reduce((sum, count) => sum + count, 0);

if (failures.length > 0) {
  console.error("FAIL  verify:layout-parity: 断行必须跨平台一致，且必须由自研决定");
  for (const failure of failures) console.error(`      ${failure}`);
  console.error("      若这次改动确实有意改变断行，重新生成指纹：");
  console.error(`      rm ${FINGERPRINT} && bun scripts/verify-layout-parity.ts`);
  process.exit(1);
}

console.log(
  `PASS  verify:layout-parity  (${CORPORA.length} 语料 × ${PRESETS.length} 预设 × ` +
    `${MEASURES.length} 版心，指纹逐字节一致；自研四条规则各有贡献（合计 ${divergent} 次）)`,
);
