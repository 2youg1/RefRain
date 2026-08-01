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
import { isInsideUnbreakable, unbreakableRanges } from "./unbreakable.ts";

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
  /**
   * 这个字符与**前一个**字符之间是否禁止断行。
   *
   * 断行禁令有两个层级，这一位属于结构层。字符类是逐字判定的，判得出
   * 「闭括号不能在行首」，判不出「这是一条 URL 的中段」——后者跨越几十个
   * 字符，任何逐字规则都看不见它。所以结构层在这里落成一位随字符走的标记，
   * `candidates` 只需读它，不必知道 URL 长什么样。
   *
   * 标记记在「与前一个字符之间」，与 `spaceBefore` 同侧，这样下标语义一致：
   * 两者都描述 `index` 与 `index - 1` 之间的那条缝。
   */
  readonly joinedToPrevious: boolean;
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

  // 不可分区间是按 UTF-16 下标找出来的（正则只会这样报），而这里按**码点**
  // 遍历。两者在 BMP 外的字符处会错开——一个 emoji 占两个 UTF-16 码元、一个
  // 码点。逐字符累加真实码元数来换算，不要拿 index 直接去查。
  const ranges = unbreakableRanges(text);
  let utf16Offset = 0;

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
      joinedToPrevious: index > 0 && isInsideUnbreakable(ranges, utf16Offset),
    });
    utf16Offset += character.length;
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
 * - **句读 + 句读**：`，，` `？！` `。。` — 最常见的一种，第一版漏了
 *
 * ## 开 + 开与闭 + 闭：按规范压，不按我的推理
 *
 * 第一版这里写了「`「「` 两个开括号的内白都在左侧，中间本来就没有多余空白，
 * 压了会让字挤在一起」，因此不压。这个推理讲得通，而且与 Chromium 的行为
 * 恰好相反（它压 0.5em），所以对拍时我一度认为是我们更对。
 *
 * 查规范之后改判。CLREQ §6.3.2 的原文是「**两个相邻标点**（原占 2 字）压到
 * 1.5 字宽」——它没有按开闭分类。真正做这个区分的是韩文：KLREQ §7.3.3 明写
 * 「开+开 / 闭+闭 排紧」，中文规范里没有对应条款。
 *
 * 所以这里按 CLREQ 一律压半字。我那条推理保留在这里作为**待裁项**：它关心的
 * 是字形内白的实际分布，而 CLREQ 给的是版面规则；两者在 `「「` 这种连续开括号
 * 上可能真的有分歧，但那需要拿真实字体的 ink box 量过才能推翻规范，而不是
 * 靠推理。在量出证据之前，规范优先。
 *
 * ## 句读 + 句读这条是对着浏览器实测补的
 *
 * 与 Chromium 原生断行对拍时，我们的断行在 33/37 段上比它差 288%，几乎每段
 * 都多断一行。查下来不是算法差，是**我们把标点算宽了**：
 *
 * | 探针（Noto Serif SC 16px） | 实测 |
 * |---|---|
 * | 单个 `，` | 16px = 1.0em |
 * | `，，` | 24px（第二个只占 0.5em） |
 * | `，`×10 | 88px（首个 1.0em，其余各 0.55em） |
 * | `，`×5 + `text-spacing-trim: space-all` | 80px（挤压被关掉，回到 1.0em） |
 *
 * 也就是说 **Chromium 默认就在做连续标点挤压**，那是 `text-spacing-trim`
 * 的默认行为；而我们的表里没有「句读+句读」，于是每遇到一处连续标点就高估
 * 半个字身，行提前判定放不下。这个偏差在标点密集的段落里累积成整整一行。
 *
 * 注意这条规则**属于排版规范而不是字体**：Chiron Sung HK 实测 `，` 恒为
 * 1.0em 不挤压（同一个浏览器、同一段 CSS）。字体只决定字形自带多少内白，
 * 压不压是排版层的决定——这正是 Plan §3.0-1 撤掉字体级 `halt`/`palt` 的
 * 理由，也是这张表必须由我们自己拥有的理由。
 */
function squeezeBetween(left: CharClass, right: CharClass): number {
  const HALF = -0.5;
  if (left === "close" && right === "open") return HALF;
  if (left === "stop" && (right === "close" || right === "open")) return HALF;
  // 句读 + 句读：`，，`、`？！`、`。。`。两个句读点各自的右侧内白连在一起，
  // 与「句读 + 闭」是同一个空洞，只是右边那个字符换了个类。
  if (left === "stop" && right === "stop") return HALF;
  // 闭 + 句读：`」，`。闭括号右侧的内白与句读点左侧的内白相邻。这是「句读 +
  // 闭」的镜像，第一版只写了一个方向。
  if (left === "close" && right === "stop") return HALF;
  // 开 + 开、闭 + 闭：CLREQ §6.3.2 说的是「两个相邻标点」，不按开闭分类。
  if (left === "open" && right === "open") return HALF;
  if (left === "close" && right === "close") return HALF;
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
