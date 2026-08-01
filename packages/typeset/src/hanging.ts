/**
 * 标点悬挂：排版顺序的第 8 步，**断点稳定之后**才应用。
 *
 * 顺序是硬的：悬挂若参与行宽计算，加进去的那一点宽度会改变断点，而断点变了
 * 又要重算悬挂。所以它只在断点定下来之后调整最后一个字符的位置，不回头影响
 * 行宽。
 *
 * **默认关闭，且不是一个全局开关**：
 *
 * - JLREQ §2.5.1 / §3.8.2 明说悬挂**不在** JIS X 4051 的规范正文里，只见于
 *   解说，且不适合日欧混排。
 * - CLREQ §6.1.3 说中文多数出版物不用，繁体横排尤其不宜。
 *
 * 所以它是「日文预设可选、中文横排默认关」。把它做成一个跨语言的开关，等于
 * 把一条只在某一种排版传统里成立的做法强加给另一种。
 */

import type { TypesetPreset } from "./preset.ts";
import type { AdjustedChar } from "./spacing.ts";

/** 一行末尾挂出版心的量（em）。0 表示不挂。 */
export type Hang = {
  /** 挂出去的字符在整段里的下标。 */
  readonly index: number;
  /** 挂出版心的宽度，em。 */
  readonly amountEm: number;
};

/**
 * 这一行的行尾要不要悬挂，挂多少。
 *
 * `lineEnd` 是该行最后一个字符的下标（含）。返回 null 表示不挂——预设关掉了
 * 悬挂，或者行尾那个字符不是可挂的类。
 */
export function hangingAt(
  measured: readonly AdjustedChar[],
  lineEnd: number,
  preset: TypesetPreset,
): Hang | null {
  if (preset.hangPolicy === "none") return null;

  const last = measured[lineEnd];
  if (last === undefined) return null;

  // 只有句读点可挂。闭括号不挂：它是一对括号的一半，挂出去会让右边缘上
  // 一半的括号在版心内、一半在版心外。
  if (last.kind !== "stop") return null;

  return { index: lineEnd, amountEm: 0.5 };
}
