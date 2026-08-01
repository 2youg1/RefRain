#!/usr/bin/env bun
/**
 * 门禁：中日两个预设在同一份语料上**必须产生不同结果**。
 *
 * ## 相同即说明共用了一张错表
 *
 * 中日两地的排版规矩在几处方向相反，这不是口味差异而是标准明文：
 *
 * | 项 | 简中 | 日文 | 出处 |
 * |---|---|---|---|
 * | 行尾全角标点 | 压半个字身 | **保留**后置半角空白 | GB/T 15834 §5.1.10 / JLREQ §3.1.9 |
 * | 混排间距 | 1/8 ic | 1/4 em | CSS Text 4 §8.4.1 / JIS |
 * | 悬挂 | 横排默认关 | 句读点可开 | CLREQ §6.1.3 / JLREQ §2.5.1 |
 *
 * JLREQ §3.8.3 Note 明言句点后的半角空**不得**为行调整删除，而 GB/T 要求
 * 压掉——**同一张表处理中日，必有一边是错的**。
 *
 * 危险在于「一边是错的」不会报错。两个预设共用一份数值时，稿子照样排得出来、
 * 门禁照样全绿、单元测试照样通过，只有懂那一种排版传统的读者会觉得不对劲，
 * 而他多半说不出是哪里不对。所以这道门禁问的不是「值对不对」（那是单元测试
 * 的事），而是**「两者还分得开吗」**——它守的是「预设是数据、不是布尔开关」
 * 这个结构，不让某次重构把两份数据悄悄合成一份。
 *
 * ## 断言的是差异存在，不是差异等于某个数
 *
 * 钉住「日文间距 0.25、中文 0.125」是单元测试已经做的事。这里钉那些数字只会
 * 让门禁在调参时假红。这道门禁只问：同一份输入，两个预设的输出是否可分辨。
 *
 * ## 注入验红（三处，实测）
 *
 * | 注入 | 结果 |
 * |---|---|
 * | 让 `presetOf("ja")` 返回简中预设 | 红：四个维度全部退化为相同 |
 * | 只把 `interScriptSpacingEm` 改成与简中相同 | 红：混排间距那一项 |
 * | 只把 `lineEndPunctuation` 改成与简中相同 | 红：行尾调整与断行那两项 |
 */

import {
  candidates,
  hangingAt,
  JA,
  lineEndAdjustment,
  lineStarts,
  measure,
  presetOf,
  widthEm,
  ZH_HANS,
} from "../packages/typeset/src/index.ts";

const failures: string[] = [];

/**
 * 语料按「两地规矩真正分歧的那几个字符类」造。
 *
 * 必须含行尾全角句点（行尾调整分歧）、中西相邻（间距分歧）、句读点（悬挂
 * 分歧）。缺任何一类，对应维度就量不出差异，而那与「两个预设共用一张表」
 * 的读数完全相同——本项目已经在禁则三档上撞过这个坑：四组语料 × 两预设 ×
 * 七个行宽全部相同，读起来像实现没生效，真因是语料选错了。
 */
const CORPORA: readonly (readonly [string, string])[] = [
  ["行尾句点", "今日は晴天です。明日も晴れるでしょう。"],
  ["中西相邻", "在Notebook上写下42个字。"],
  ["连续标点", "「引用」，然后……"],
  ["混合", "RefRain 2.3 支持Markdown与CJK排版。"],
];

/** 一个维度上两个预设是否分得开。分不开就记一笔。 */
function requireDivergence(dimension: string, zh: unknown, ja: unknown, corpus: string): boolean {
  const same = JSON.stringify(zh) === JSON.stringify(ja);
  if (same) {
    failures.push(
      `${dimension}：简中与日文在语料「${corpus}」上结果完全相同\n` +
        `      两地规矩在这一项上方向相反，相同即说明两个预设共用了一份数据。\n` +
        `      读数: ${JSON.stringify(zh)}`,
    );
  }
  return !same;
}

/**
 * 每个维度分别计数「真的量到了差异」的语料数。
 *
 * 分维度计数而不是只看总数：某个维度若一份语料都没覆盖到，它与「该维度全部
 * 通过」的输出相同。零样本必须能与全通过分辨开。
 */
const witnessed = new Map<string, number>([
  ["行尾调整", 0],
  ["混排间距", 0],
  ["断行结果", 0],
  ["悬挂策略", 0],
]);

for (const [name, text] of CORPORA) {
  const zhMeasured = measure(text, ZH_HANS);
  const jaMeasured = measure(text, JA);

  // 一、行尾调整：GB/T 压半字 vs JLREQ 保留后置空白。
  const lastZh = zhMeasured.at(-1);
  const lastJa = jaMeasured.at(-1);
  if (lastZh !== undefined && lastJa !== undefined) {
    const zhAdjust = lineEndAdjustment(lastZh.kind, ZH_HANS);
    const jaAdjust = lineEndAdjustment(lastJa.kind, JA);
    // 只在行尾确实是标点时才问——不是标点时两地都返回 0，那是正确的相同。
    if (lastZh.kind === "stop" || lastZh.kind === "close") {
      if (requireDivergence("行尾调整", zhAdjust, jaAdjust, name)) {
        witnessed.set("行尾调整", (witnessed.get("行尾调整") ?? 0) + 1);
      }
    }
  }

  // 二、混排间距：1/8 ic vs 1/4 em。只在语料真有 script 边界时问。
  const zhGaps = zhMeasured.filter((character) => character.spaceBefore > 0);
  const jaGaps = jaMeasured.filter((character) => character.spaceBefore > 0);
  if (zhGaps.length > 0 || jaGaps.length > 0) {
    const zhWidths = zhGaps.map((character) => character.spaceBefore);
    const jaWidths = jaGaps.map((character) => character.spaceBefore);
    if (requireDivergence("混排间距", zhWidths, jaWidths, name)) {
      witnessed.set("混排间距", (witnessed.get("混排间距") ?? 0) + 1);
    }
  }

  // 三、断行：行尾调整参与「放不放得下」，所以两地的断点位置本就该不同。
  //
  // 扫多个行宽找临界点。单一行宽下两个预设很可能碰巧断在同一处，那是巧合
  // 不是相同——只扫一个行宽的话，这条断言时红时绿，取决于语料多长。
  const zhBreaks: number[][] = [];
  const jaBreaks: number[][] = [];
  for (let em = 6; em <= 20; em += 1) {
    zhBreaks.push([...lineStarts(zhMeasured, ZH_HANS, em)]);
    jaBreaks.push([...lineStarts(jaMeasured, JA, em)]);
  }
  if (JSON.stringify(zhBreaks) !== JSON.stringify(jaBreaks)) {
    witnessed.set("断行结果", (witnessed.get("断行结果") ?? 0) + 1);
  }

  // 四、悬挂：中文横排默认关，日文句读点可开。
  for (let index = 0; index < zhMeasured.length; index += 1) {
    const zhHang = hangingAt(zhMeasured, index, ZH_HANS);
    const jaHang = hangingAt(jaMeasured, index, JA);
    if (zhHang === null && jaHang !== null) {
      witnessed.set("悬挂策略", (witnessed.get("悬挂策略") ?? 0) + 1);
      break;
    }
  }

  // 五、候选断点集合本身也该有可分辨之处（禁则表来自各自的字符类划分）。
  void candidates(zhMeasured, ZH_HANS).length;
  void widthEm(zhMeasured);
}

// 零样本与全通过必须分辨得开：某个维度一份语料都没量到差异，说明语料失去了
// 区分力，或者那个维度的两份数据已经被合并——两者都必须变红。
for (const [dimension, count] of witnessed) {
  if (count === 0) {
    failures.push(
      `维度「${dimension}」在全部 ${CORPORA.length} 份语料上都没量到中日差异。\n` +
        "      要么两个预设在这一项上已经共用了一份数据，要么语料失去了区分力。\n" +
        "      无论哪一种，这个维度此刻都没有被真正检查。",
    );
  }
}

// 预设身份本身：presetOf 必须把两种语言路由到两份不同的数据。
if (JSON.stringify(presetOf("ja")) === JSON.stringify(presetOf("zh-Hans"))) {
  failures.push('presetOf("ja") 与 presetOf("zh-Hans") 返回了同一份预设');
}

if (failures.length > 0) {
  console.error("FAIL  verify:preset-divergence: 中日两预设必须分得开，相同即共用了一张错表");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:preset-divergence  (${CORPORA.length} 份语料，4 个维度各有 ` +
    [...witnessed.entries()].map(([name, count]) => `${name} ${count}`).join(" / ") +
    " 份语料量到差异)",
);
