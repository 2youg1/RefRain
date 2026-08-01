/**
 * 排版预设：一份数据，不是一堆布尔。
 *
 * 最能说明为什么必须分成两份的反例（CJK 研究结论 1）：GB/T 15834 §5.1.10
 * 要求行尾的全角标点压掉半个字身；JLREQ §3.1.9 把句点看作「半角字身 + 后置
 * 半角空白」，而**行尾那段空白原则上保留**。同一张表处理中文与日文，必有
 * 一边是错的——所以这里是两份数据，而不是一份数据加几个开关。
 *
 * 两条已核实的修正，都与常见做法相反：
 *
 * 1. **混排间距默认不是 1/4em。** CLREQ §6.3.3 的 1/4 是**上界**；CSS Text 4
 *    §8.4.1 的规范值是 1/8 ic。日文按 JIS 用 1/4 em。
 * 2. **`line-break` 的三档不等于 CLREQ 的四档。** 前者是 Unicode tailoring 的
 *    三个严格度值，后者是四个语义档，要四档必须自备字符表。
 *
 * 悬挂默认关（`hangPolicy: "none"`）：JLREQ §2.5.1 / §3.8.2 说悬挂**不在**
 * JIS X 4051 的规范正文里、只见于解说，且不适合日欧混排；CLREQ §6.1.3 说
 * 中文多数出版物不用，繁体横排尤其不宜。所以它是日文预设可选的一项，不是
 * 一个全局开关。
 */

import type { CharClass } from "./char-class.ts";

/** 禁则的严格度。三档必须产生**可见不同**的断行，否则这个选项是装饰。 */
export type BreakStrictness = "loose" | "normal" | "strict";

/** 悬挂策略。中文横排默认关，不是一个全局开关。 */
export type HangPolicy = "none" | "stops";

/** 行尾全角标点怎么处理。两地规矩不同，这是两份预设存在的根本理由。 */
export type LineEndPunctuation =
  /** GB/T 15834：行尾全角标点压半个字身。 */
  | "compress-half"
  /** JLREQ：半角字身 + 后置半角空白，且行尾这段空白原则上保留。 */
  | "keep-trailing-space";

/** 一份预设。全部是数据；没有任何一项是行为开关。 */
export type TypesetPreset = {
  readonly id: "zh-hans" | "zh-hant" | "ja";
  /** 断行严格度的默认档。 */
  readonly breakStrictness: BreakStrictness;
  /** 行尾全角标点的处理。 */
  readonly lineEndPunctuation: LineEndPunctuation;
  /**
   * 中西混排间距，单位是 em。
   *
   * 简中取 CSS Text 4 §8.4.1 的规范值 1/8；日文取 JIS 的 1/4。这两个数不是
   * 品味，是各自规范里写下的值。
   */
  readonly interScriptSpacingEm: number;
  /** 悬挂策略。 */
  readonly hangPolicy: HangPolicy;
  /** 行首不许出现的字符类。 */
  readonly forbiddenAtLineStart: ReadonlySet<CharClass>;
  /** 行尾不许出现的字符类。 */
  readonly forbiddenAtLineEnd: ReadonlySet<CharClass>;
};

/**
 * 简体中文。
 *
 * 行尾标点压半字（GB/T 15834 §5.1.10）；混排间距 1/8 ic（CSS Text 4）；
 * 横排不悬挂（CLREQ §6.1.3：中文多数出版物不用）。
 */
export const ZH_HANS: TypesetPreset = {
  id: "zh-hans",
  breakStrictness: "normal",
  lineEndPunctuation: "compress-half",
  interScriptSpacingEm: 0.125,
  hangPolicy: "none",
  forbiddenAtLineStart: new Set<CharClass>(["close", "stop", "middle", "extender"]),
  forbiddenAtLineEnd: new Set<CharClass>(["open"]),
};

/**
 * 繁体中文。
 *
 * 与简中同源，但横排尤其不宜悬挂（CLREQ §6.1.3 明说繁体横排不宜），
 * 所以它与简中在悬挂这一项上不共享一个默认。
 */
export const ZH_HANT: TypesetPreset = {
  id: "zh-hant",
  breakStrictness: "normal",
  lineEndPunctuation: "compress-half",
  interScriptSpacingEm: 0.125,
  hangPolicy: "none",
  forbiddenAtLineStart: new Set<CharClass>(["close", "stop", "middle", "extender"]),
  forbiddenAtLineEnd: new Set<CharClass>(["open"]),
};

/**
 * 日文。
 *
 * 行尾句点保留后置空白（JLREQ §3.1.9）——这与简中的「压半字」正好相反，
 * 是两份预设不能合并的那一条。混排间距 1/4 em（JIS）。句读点可以悬挂。
 */
export const JA: TypesetPreset = {
  id: "ja",
  breakStrictness: "normal",
  lineEndPunctuation: "keep-trailing-space",
  interScriptSpacingEm: 0.25,
  hangPolicy: "stops",
  forbiddenAtLineStart: new Set<CharClass>(["close", "stop", "middle", "extender"]),
  forbiddenAtLineEnd: new Set<CharClass>(["open"]),
};

/** 全部内建预设。新增一种语言时这里是唯一的登记处。 */
export const PRESETS: Readonly<Record<TypesetPreset["id"], TypesetPreset>> = {
  "zh-hans": ZH_HANS,
  "zh-hant": ZH_HANT,
  ja: JA,
};

/** 按 id 取预设；未知的 id 落到简中，因为那是本项目的主要语言。 */
export function presetOf(id: string): TypesetPreset {
  return PRESETS[id as TypesetPreset["id"]] ?? ZH_HANS;
}
