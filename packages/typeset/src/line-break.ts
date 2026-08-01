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
 * 断在词中间要付的代价。
 *
 * 取 15：它必须**高于** `lineStarts` 里那道 `ACCEPTABLE_PENALTY = 20` 的
 * 门槛之下的自然代价（表意文字之间是 0），又必须**低于**「宁可撑破版心」。
 * 15 落在两者之间——单独一个词中间断点（0 + 15 = 15）仍在可接受档内，所以
 * 没有别的选择时照样断得下去；而只要同一段里存在一个词边界断点（代价 0），
 * 最优解就会优先选它。
 *
 * 不取更大的值，是因为代价一旦越过 20，词中间就从「不情愿」变成「拒绝」，
 * 那与 `BreakCandidate.penalty` 那句「语义断行只作软代价」相矛盾——一个
 * 没有词边界可用的窄版心会被逼到撑破版心，而切开一个词远比那轻。
 */
const WORD_INTERIOR = 15;

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
  wordStarts?: ReadonlySet<number>,
): readonly BreakCandidate[] {
  const found: BreakCandidate[] = [];

  for (let index = 1; index < measured.length; index += 1) {
    const before = measured[index - 1];
    const after = measured[index];
    if (before === undefined || after === undefined) continue;

    // 结构层禁令先于字符类禁令：URL、路径、行内代码、带单位的数值内部不断，
    // 无论两侧字符是什么类。逐字规则看不见这个层级（`/` 与 `.` 单看都是普通
    // 标点），所以它必须在这里作为一条独立的门槛出现。
    if (after.joinedToPrevious) continue;

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

    const base = penaltyAt(before.kind, after.kind, strictness);
    // 语义代价是**加**上去的，不是替换。字符类的判据仍然全额生效——一个
    // 恰好落在词首的长标点断点，代价还是 40。
    found.push({
      index,
      penalty: base + (wordStarts !== undefined && !wordStarts.has(index) ? WORD_INTERIOR : 0),
    });
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
 * 从 `overflowAt` 往后找这个不可分割单元的结束位置。
 *
 * 只在「这一行一个候选断点都没有」时调用。此时版心塞不下当前这个单元——
 * 一个超长西文词、一串数字、一条 URL。三种处理里只有一种是对的：
 *
 * | 做法 | 结果 |
 * |---|---|
 * | 就地硬断 | 切出 `expi` + `alidocious` 两个不存在的词 |
 * | 整行不断 | 后面的正文全跟着溢出 |
 * | **让这个单元溢出，从它结束处起新行** | 词完整，溢出止于该词 |
 *
 * 第三种是 CSS `overflow-wrap: normal` 的语义，也是所有成熟排版器的默认。
 * 返回值是下一行的起点：该单元之后第一个可断处。找不到就返回 `lineStart`，
 * 调用方据此停止断行（整段确实无处可断）。
 */
function unbreakableEnd(
  measured: readonly AdjustedChar[],
  preset: TypesetPreset,
  strictness: BreakStrictness,
  lineStart: number,
  overflowAt: number,
): number {
  const allowed = new Set(candidates(measured, preset, strictness).map((entry) => entry.index));
  for (let index = overflowAt; index < measured.length; index += 1) {
    if (index <= lineStart || !allowed.has(index)) continue;
    // 空格归上一行。断在空格**前**会让下一行以空格开头，而行首悬着一个空格
    // 是可见的瑕疵——溢出的长词后面跟着一行 `" "` 正是这个形状。正常路径不
    // 会撞到它（候选天然偏好空格后），只有这条兜底会。
    let start = index;
    while (measured[start]?.kind === "space") start += 1;
    return start > lineStart ? start : index;
  }
  return lineStart;
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
  wordStarts?: ReadonlySet<number>,
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
    candidates(measured, preset, strictness, wordStarts).map((entry) => [
      entry.index,
      entry.penalty,
    ]),
  );

  /** 断在这里划不划算。代价越低越愿意，超过这个值就宁可往前退。 */
  const ACCEPTABLE_PENALTY = 20;

  const starts: number[] = [0];
  let width = 0;
  let lastCandidate: number | null = null;
  let lastPenalty = Number.POSITIVE_INFINITY;

  for (let index = 0; index < measured.length; index += 1) {
    const character = measured[index];
    if (character === undefined) continue;
    const penalty = penalties.get(index);
    // 代价高的断点仍然是断点——放不下时它总比撑破版心好——但只要还有更便宜
    // 的选择，就不该用它。宽松档把长标点与中点的代价压到 1，正是让这些位置
    // 从「万不得已」变成「乐意」。
    //
    // 在可接受档**之内**还要比大小，不能只记最后一个。同一行里往往有好几个
    // 可接受的候选，取最后一个等于「能塞多满塞多满」——那正是词中间断点的
    // 来源：`老槐树` 的 `槐|树` 与两字之前的词边界代价都 ≤20，贪心永远选后者。
    //
    // 只在**更便宜**时才改记，代价相同时保留更靠后的那个（行更满）。语义
    // 断行正是靠这一条起作用：词中间 +15 之后不再与词边界的 0 等价。
    if (penalty !== undefined && penalty <= ACCEPTABLE_PENALTY) {
      if (lastCandidate === null || penalty <= lastPenalty) {
        lastCandidate = index;
        lastPenalty = penalty;
      }
    }

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
      // 放不下时退到上一个候选断点。一个都没有的情况需要分开处理，第一版在这
      // 里一律「就地硬断」，而那正好切在不可分割的单元中间。
      //
      // 实测 @12em：`supercalifragilisticexpialidocious antidisestablishment…`
      // 被切成 `supercalifragilisticexpi` + `alidocious`。`candidates` 明明
      // 已经禁止西文内部断开（西文与西文之间不生成候选），禁令却在最后一步被
      // 兜底绕过——**候选集说了不能断的地方，兜底不该有权限断**。
      //
      // 一行放不下一个单词，正确行为是让它溢出（读者仍读得到完整的词，只是
      // 越出版心），而不是切出两个不存在的词。CSS 的 `overflow-wrap: normal`
      // 就是这个语义，它才是默认值；`break-all` 是要显式开的另一回事。
      const start =
        lastCandidate !== null && lastCandidate > (starts.at(-1) ?? 0)
          ? lastCandidate
          : unbreakableEnd(measured, preset, strictness, starts.at(-1) ?? 0, index);
      if (start <= (starts.at(-1) ?? 0)) {
        // 整段到此都不可分：让它溢出，不再尝试断这一行。
        break;
      }
      starts.push(start);
      lastCandidate = null;
      // 代价也要跟着清。留着上一行的最低代价，下一行就只肯接受比它更便宜的
      // 候选——一行一旦断在代价 0 处，之后每一行都不再接受代价 10 的位置。
      lastPenalty = Number.POSITIVE_INFINITY;
      // 重新从新行的起点量起。
      width = 0;
      index = start - 1;
      continue;
    }
    width += advance;
  }

  return starts;
}
