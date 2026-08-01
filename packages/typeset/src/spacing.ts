/**
 * 挤压与混排间距：排版顺序的第 3 步与第 4 步。
 *
 * **第 3 步必须早于生成候选断点**（CLREQ 明说挤压会改变换行位置）。把禁则
 * 当字符黑名单、换行之后再修补，得到的是错误的断点与疏松的行。所以这里
 * 输出的是每个字符的调整量，供后续步骤在**知道调整量之后**再去算断点。
 *
 * 输出是纯数据：每个位置一个以 em 为单位的调整值。谁把它画出来是视口的事，
 * 这里不碰 DOM，也不假设有 DOM。
 *
 * **磁盘字节不变**是贯穿全版的不变量：调整量是渲染派生物，不写回 `.md`、
 * 不进 Source Backup、不进复制文本。这个模块拿字符串进、拿数字出，从构造
 * 上就无法违反它。
 */

import { type CharClass, classOf, isWesternSide } from "./char-class.ts";
import type { TypesetPreset } from "./preset.ts";

/** 一个字符在版面上的样子。位置按 code point 计，不按 UTF-16 单元。 */
export type AdjustedChar = {
  readonly text: string;
  readonly kind: CharClass;
  /**
   * 这个字符**之前**要加的空白，单位 em。负值表示压缩。
   *
   * 空白记在「之前」而不是「之后」：行首要不要保留这段空白是一个真问题
   * （JLREQ §3.1.9 的行尾空白就是它的镜像），记在之前才问得出来。
   */
  readonly spaceBefore: number;
};

/**
 * 量一段文本。
 *
 * 两件事在这里同时发生，因为它们看的是同一对相邻字符：
 *
 * 1. **连续标点挤压**——闭括号后面紧跟开括号、句读点后面紧跟闭括号这类
 *    组合会留下一个视觉空洞，压掉半个字身。
 * 2. **混排间距**——表意文字与西文/数字相邻处插入一段空白，目标是视觉
 *    密度均等而不是某个固定数值。间距值来自预设，因为简中（1/8 ic）与
 *    日文（1/4 em）的规范值本来就不同。
 */
export function measure(text: string, preset: TypesetPreset): readonly AdjustedChar[] {
  const characters = [...text];
  const result: AdjustedChar[] = [];

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === undefined) continue;
    const kind = classOf(character);
    const previous = index === 0 ? null : (characters[index - 1] ?? null);
    const previousKind = previous === null ? null : classOf(previous);

    result.push({
      text: character,
      kind,
      spaceBefore: previousKind === null ? 0 : gapBetween(previousKind, kind, preset),
    });
  }

  return result;
}

/**
 * 两个相邻字符类之间要加多少空白（em）。
 *
 * 挤压与间距在同一处决定，因为它们回答的是同一个问题。先问挤压：一旦这对
 * 字符要压，就不会再有混排间距的事——它们都是全角标点，之间没有 script
 * 边界。
 */
function gapBetween(left: CharClass, right: CharClass, preset: TypesetPreset): number {
  const squeeze = squeezeBetween(left, right);
  if (squeeze !== 0) return squeeze;

  // 混排间距：表意文字与西文之间。两个方向都要加——「中文abc」与「abc中文」
  // 是同一种边界，只加一侧会让同一句话的两端疏密不同。
  const crossesScript =
    (left === "ideograph" && isWesternSide(right)) ||
    (isWesternSide(left) && right === "ideograph");
  if (crossesScript) return preset.interScriptSpacingEm;

  return 0;
}

/**
 * 连续全角标点之间压掉多少（负值，em）。
 *
 * 压半个字身的三种组合，都是**两个全角标点各自带着自己的内白**相邻时留下
 * 的空洞：
 *
 * - 闭 + 开：`」「` — 两侧内白挨在一起
 * - 句读 + 闭：`。」` — 句读点右侧的内白与闭括号左侧的内白
 * - 句读 + 开：`，「` — 同上
 *
 * 开 + 开与闭 + 闭不压：`「「` 两个开括号的内白都在左侧，中间本来就没有
 * 多余空白，压了会让字挤在一起。这条区分是「按类定规矩」而不是「按是不是
 * 标点定规矩」的理由。
 */
function squeezeBetween(left: CharClass, right: CharClass): number {
  const HALF = -0.5;
  if (left === "close" && right === "open") return HALF;
  if (left === "stop" && (right === "close" || right === "open")) return HALF;
  return 0;
}

/**
 * 这一行的行尾标点该怎么处理——两地规矩相反的那一条。
 *
 * 简中压掉半个字身（GB/T 15834 §5.1.10）；日文保留后置的半角空白
 * （JLREQ §3.1.9）。返回的是行尾要额外调整的量（em）。
 */
export function lineEndAdjustment(lastKind: CharClass, preset: TypesetPreset): number {
  if (lastKind !== "stop" && lastKind !== "close") return 0;
  return preset.lineEndPunctuation === "compress-half" ? -0.5 : 0;
}

/** 一段文本按预设量出来的总宽（em）。字符按一个字身计，西文按半个。 */
export function widthEm(measured: readonly AdjustedChar[]): number {
  let width = 0;
  for (const character of measured) {
    width += character.spaceBefore;
    width += isWesternSide(character.kind) || character.kind === "space" ? 0.5 : 1;
  }
  return width;
}
