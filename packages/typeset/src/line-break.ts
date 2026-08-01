/**
 * 候选断点与禁则：排版顺序的第 5 步。
 *
 * **它必须在挤压之后跑**（CLREQ 明说挤压会改变换行位置）——所以入参是已经
 * 量过的字符序列，而不是原始字符串。顺序反过来会得到错误的断点与疏松的行。
 *
 * 三档严格度必须产生**可见不同**的断行。结果相同这个选项就是装饰，所以
 * 三档各自禁掉的东西在这里是三份不同的数据，不是同一份数据配三个阈值。
 */

import type { CharClass } from "./char-class.ts";
import type { BreakStrictness, TypesetPreset } from "./preset.ts";
import { type AdjustedChar, lineEndAdjustment } from "./spacing.ts";

/** 一个候选断点：在第 `index` 个字符**之前**可以换行。 */
export type BreakCandidate = {
  readonly index: number;
  /**
   * 断在这里的代价。0 是自然断点，越大越不情愿。
   *
   * 代价而非禁止：语义断行只作软代价，编辑器表达不了的时候延到只读预览器，
   * 而不是让一条建议变成一条硬规则。
   */
  readonly penalty: number;
};

/**
 * 宽松档额外允许断开的类。
 *
 * 宽松档允许在长标点与中点前后断——严格档不允许。这是三档产生不同结果的
 * 来源之一：一句含 `……` 与 `・` 的日文，在三档下断点集合不同。
 */
const LOOSE_ALLOWS = new Set<CharClass>(["extender", "middle"]);

/**
 * 严格档额外禁止断开的类。
 *
 * 严格档连数字与西文之间也不断，于是一个长数字或一个长单词会把整行推出去，
 * 交给第 6 步的挤压去收——这正是严格档看起来「更满」的原因。
 */
const STRICT_FORBIDS = new Set<CharClass>(["digit", "latin"]);

/**
 * 生成候选断点。
 *
 * 规则的次序即优先级：先问预设的禁则（行首不可现、行尾不可留），再问严格度
 * 这一档额外的增减。禁则来自预设，因为中日两地的字符类划分本来就不同。
 */
export function candidates(
  measured: readonly AdjustedChar[],
  preset: TypesetPreset,
  strictness: BreakStrictness = preset.breakStrictness,
): readonly BreakCandidate[] {
  const found: BreakCandidate[] = [];

  for (let index = 1; index < measured.length; index += 1) {
    const before = measured[index - 1];
    const after = measured[index];
    if (before === undefined || after === undefined) continue;

    // 行首不可现：断在这里会让 after 成为下一行的第一个字。
    if (preset.forbiddenAtLineStart.has(after.kind)) continue;
    // 行尾不可留：断在这里会让 before 成为这一行的最后一个字。
    if (preset.forbiddenAtLineEnd.has(before.kind)) continue;

    // 不可分序列：数字与数字之间、西文与西文之间绝不断开。
    // `12.5` 与 `hello` 被断成两行是数据读起来的损坏，不是版面问题。
    if (before.kind === after.kind && (before.kind === "digit" || before.kind === "latin")) {
      continue;
    }
    // 数字与小数点之间同理：`12.5` 的 `.` 归 other 类，单看类判不出来。
    if (before.kind === "digit" && after.text === ".") continue;
    if (before.text === "." && after.kind === "digit") continue;

    if (
      strictness === "strict" &&
      (STRICT_FORBIDS.has(before.kind) || STRICT_FORBIDS.has(after.kind))
    ) {
      continue;
    }

    found.push({ index, penalty: penaltyAt(before.kind, after.kind, strictness) });
  }

  return found;
}

/**
 * 断在这一处有多不情愿。
 *
 * 表意文字之间断开是零代价——中文与日文本来就逐字换行。跨 script 的边界
 * 略有代价：断在那里读起来像把一个词拆开了，尽管语法上允许。
 */
function penaltyAt(left: CharClass, right: CharClass, strictness: BreakStrictness): number {
  if (left === "ideograph" && right === "ideograph") return 0;

  // 宽松档愿意在长标点与中点处断，代价压到很低；其余两档不给这个便利。
  if (strictness === "loose" && (LOOSE_ALLOWS.has(left) || LOOSE_ALLOWS.has(right))) {
    return 1;
  }
  if (LOOSE_ALLOWS.has(left) || LOOSE_ALLOWS.has(right)) return 40;

  return 10;
}

/**
 * 按行宽把一段文本折行，返回每行起始的字符下标。
 *
 * 这是把断点变成版面的最后一步。它取的是「放不下就退到上一个候选断点」，
 * 不做 Knuth-Plass 的全局最优——本版不接管段落断行（contenteditable 里
 * 自管行盒要一并接管光标、选区、输入法，代价远超收益）。这个函数存在的
 * 理由是让门禁能在**不开浏览器**的情况下比较两个预设的断行结果。
 */
export function lineStarts(
  measured: readonly AdjustedChar[],
  preset: TypesetPreset,
  measureEm: number,
  strictness: BreakStrictness = preset.breakStrictness,
): readonly number[] {
  // 代价必须参与选择，不能只看「在不在候选集里」。
  //
  // 实测（`他想说什么……可是又停住了……最后什么也没说。`）：loose 与 normal
  // 的候选集**完全相同**，17 个下标一模一样，唯一的差别是长标点处的代价
  // 1 对 40。第一版这里只建了一个 Set，于是那个差别在最后一步被整个丢掉，
  // 三档里只有 strict 分得出来——而 strict 之所以分得出来，是因为它在
  // `candidates` 里就把候选删掉了，不是因为这里读懂了代价。
  //
  // 换句话说，宽松档当时是个装饰品：它改的量没有任何东西会读。
  const penalties = new Map(
    candidates(measured, preset, strictness).map((entry) => [entry.index, entry.penalty]),
  );

  /** 断在这里划不划算。代价越低越愿意，超过这个值就宁可往前退。 */
  const ACCEPTABLE_PENALTY = 20;

  const starts: number[] = [0];
  let width = 0;
  let lastCandidate: number | null = null;

  for (let index = 0; index < measured.length; index += 1) {
    const character = measured[index];
    if (character === undefined) continue;
    const penalty = penalties.get(index);
    // 代价高的断点仍然是断点——放不下时它总比撑破版心好——但只要还有更便宜
    // 的选择，就不该用它。宽松档把长标点与中点的代价压到 1，正是让这些位置
    // 从「万不得已」变成「乐意」。
    if (penalty !== undefined && penalty <= ACCEPTABLE_PENALTY) lastCandidate = index;

    const advance =
      character.spaceBefore +
      (character.kind === "latin" || character.kind === "digit" || character.kind === "space"
        ? 0.5
        : 1);

    // 行尾调整必须参与「放不放得下」这个判断。
    //
    // 简中在行尾把全角标点压掉半个字身（GB/T 15834 §5.1.10），日文保留那段
    // 后置空白（JLREQ §3.1.9）——两地规矩相反。不在这里算进去，两个预设就
    // 会给出完全相同的断行，而那正是「共用了一张错表」的样子：间距差存在于
    // 数据里，却从未影响过任何一处版面。
    const trailing = lineEndAdjustment(character.kind, preset);
    if (width + advance + trailing > measureEm && width > 0) {
      // 放不下：退到上一个候选断点；一个都没有就在这里硬断，因为一行放不下
      // 一个字的版面已经不是排版问题了。
      const start =
        lastCandidate !== null && lastCandidate > (starts.at(-1) ?? 0) ? lastCandidate : index;
      starts.push(start);
      lastCandidate = null;
      // 重新从新行的起点量起。
      width = 0;
      index = start - 1;
      continue;
    }
    width += advance;
  }

  return starts;
}
