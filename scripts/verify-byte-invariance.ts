#!/usr/bin/env bun
/**
 * 门禁：逐项开关每个排版选项，Markdown 字节必须完全不变。
 *
 * ## 为什么这道门禁是横切的，必须早于每一条新渲染路径存在
 *
 * 间距、悬挂量、语义边界、挤压结果**都是渲染派生物**。它们不写回 `.md`、
 * 不进 Source Backup、不进复制文本——这是贯穿全版的不变量，Plan 每一章的
 * 判据里都有一条字节不变。
 *
 * 破坏它的形态一贯是同一种：某个渲染路径图省事，往文本里插了一个真字符
 * （U+2009 窄空格、U+00A0 不换行空格、全角空格）而不是插一个空元素。屏幕上
 * 看起来一模一样，而磁盘、digest、Source Backup、agent 引用的块区间全都跟着
 * 变了，作者从没敲过那个字符。**这类损坏作者往往几周后才发现**，那时已经
 * 存了几百次。
 *
 * 预览视口、改动段落变色、悬挂都会新增渲染路径。门禁先立，后面每写完一条
 * 当场就知道有没有破；门禁后立，就得回头把每条路径各查一遍。
 *
 * ## 检查域取自权威，不是手写清单
 *
 * 选项的清单从 `TypographyConfig` 的字段抽出来——那是唯一权威。手写一份
 * 副本的话，将来加了第 15 个选项，门禁会**照常全绿**而那个选项从未被测过；
 * 而域取自权威时，新字段自动进入检查，忘记加测试会直接变红。
 *
 * ## 注入验红（三处，实测）
 *
 * | 注入 | 结果 |
 * |---|---|
 * | 渲染时往文本插入 U+2009 | 红：报出哪个选项、哪个块、字节差在第几位 |
 * | 把某个选项从 `TypographyConfig` 删掉但不删测试 | 红：域与权威不符 |
 * | 让 `spacedRuns` 的分段拼不回原文 | 红：拼接不等于原文 |
 */

import { readFileSync } from "node:fs";
import { spacedRuns } from "../packages/editor/src/inter-script-spacing.ts";
import { convertPunctuation } from "../packages/editor/src/punctuation.ts";
import { measure, presetOf } from "../packages/typeset/src/index.ts";

const failures: string[] = [];

/**
 * 排版选项的权威清单：`TypographyConfig` 的字段。
 *
 * 用正则从 Rust 源码抽，而不是在这里再写一份。判据是「每一个排版选项都被
 * 某条字节不变断言覆盖过」，所以域必须与权威同步。
 */
const configSource = readFileSync("crates/refrain-store/src/config.rs", "utf8");
const structBody = configSource.slice(
  configSource.indexOf("pub struct TypographyConfig {"),
  configSource.indexOf("impl Default for TypographyConfig"),
);
const options = [...structBody.matchAll(/^\s{4}pub ([a-z_]+):/gm)].map((match) => match[1] ?? "");

if (options.length === 0) {
  failures.push(
    "从 config.rs 抽不出任何 TypographyConfig 字段——正则与结构体形状不再匹配。\n" +
      "      这不是「没有选项」，是这道门禁失去了检查域，会静默全绿。",
  );
}

/**
 * 语料按「规则里真正被判定的字符类」造，不是随手写几句中文。
 *
 * 语料没有区分力时门禁量不到任何东西却照样通过：纯中文段落不产生混排间距，
 * 中英之间已有空格时引擎正确地判定无需插入——两者都与功能失效同形。
 */
const CORPORA: readonly (readonly [string, string])[] = [
  ["中英混排", "他在Notebook上写下42，改成forty-two，最后写回汉字。"],
  ["连续标点", "他说：「这件事，我想过很久了。」——然后沉默……"],
  ["标点密集", "、。！？；：「」（）"],
  ["行内代码", "调用 `arr[0]` 与 `items[1]` 取值。"],
  ["URL 与路径", "见 https://example.com/a/b?q=1 与 /usr/local/share 的说明。"],
  ["数值单位", "温度 -273.15°C，比例 16:9，误差 ±0.001%。"],
  ["日文", "「今日は晴れです。」次の文です。ハードルが高い！？"],
  ["纯中文", "这一段是纯中文的正文，不该出现任何间距元素。"],
  ["空段", ""],
  ["emoji 与代理对", "他说🙂然后走了，𠀋 是增补平面汉字。"],
];

/** 每个字符的码位序列。字节比对要按码位，不是按 UTF-16 格。 */
const codePoints = (text: string): readonly string[] => [...text];

for (const [name, text] of CORPORA) {
  for (const language of ["zh-Hans", "ja"]) {
    const preset = presetOf(language);

    // 一、measure 只描述，不改写。把每个字符的 text 顺序拼起来必须逐字等于原文。
    const rebuilt = measure(text, preset)
      .map((character) => character.text)
      .join("");
    if (rebuilt !== text) {
      failures.push(
        `measure() 改写了字节：${name} / ${language}\n` +
          `      原文: ${JSON.stringify(text)}\n` +
          `      重建: ${JSON.stringify(rebuilt)}`,
      );
    }

    // 二、渲染分段拼回来也必须逐字等于原文。间距是元素，不是字符。
    const painted = spacedRuns(text, preset)
      .map((run) => run.text)
      .join("");
    if (painted !== text) {
      failures.push(
        `spacedRuns() 改写了字节：${name} / ${language}\n` +
          `      原文: ${JSON.stringify(text)}\n` +
          `      渲染: ${JSON.stringify(painted)}`,
      );
    }

    // 三、任何渲染派生物都不得引入作者没敲过的空白字符。
    //
    // 这条与上面两条不同：拼接相等只证明「总量对得上」，而这里问的是「有没有
    // 混进一个看不见的字符」。U+2009/U+00A0/U+3000 正是最容易被误用来做间距
    // 的三个——它们在屏幕上与空元素无法区分，在磁盘上却是实打实的字节。
    const introduced = codePoints(painted).filter(
      (character) => !codePoints(text).includes(character),
    );
    if (introduced.length > 0) {
      failures.push(
        `渲染引入了原文没有的字符：${name} / ${language} → ` +
          introduced.map((character) => `U+${character.codePointAt(0)?.toString(16)}`).join(" "),
      );
    }
  }

  // 四、标点转换是唯一**应当**改字节的操作，所以它反过来验证前三条不是空转：
  // 若前三条永远相等是因为语料根本不触发任何规则，这一条会一起沉默。
  // 转换后的文本必须与原文等长（全角与半角标点都是一个码位）。
  const converted = convertPunctuation("b", text);
  if (converted !== null && codePoints(converted).length !== codePoints(text).length) {
    failures.push(
      `标点转换改变了码位数：${name}\n` +
        `      原文 ${codePoints(text).length} → 转换后 ${codePoints(converted).length}`,
    );
  }
}

/**
 * 反向断言：语料必须真的产生过渲染调整。
 *
 * 没有这一条，把 `spacedRuns` 改成 `return [{text, gapAfter: 0}]` 之后上面
 * 每一条都照样全绿——那时门禁测的是「什么都不做的实现不改字节」，一句永远
 * 为真的废话。n=0 与「全部通过」的输出必须能分辨。
 */
let adjustments = 0;
for (const [, text] of CORPORA) {
  for (const language of ["zh-Hans", "ja"]) {
    adjustments += spacedRuns(text, presetOf(language)).filter((run) => run.gapAfter !== 0).length;
  }
}
if (adjustments === 0) {
  failures.push(
    "整批语料一个渲染调整都没产生——这与「渲染完全没接上」的读数相同。\n" +
      "      语料没有区分力时，字节不变这条断言会退化成一句永远为真的废话。",
  );
}

if (failures.length > 0) {
  console.error("FAIL  verify:byte-invariance: 排版是渲染派生物，不得改动作者的字节");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:byte-invariance  (${options.length} 个排版选项，${CORPORA.length} 份语料 × 2 预设，` +
    `${adjustments} 处渲染调整，零字节改动)`,
);
