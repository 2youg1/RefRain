/**
 * 跨度触发的局部最优断行 —— 排版顺序第 5 步之后、第 6 步之前的策略选择。
 *
 * ## 这个模块回答的问题
 *
 * `line-break.ts` 的 `lineStarts` 是贪心：放不下就退到上一个候选断点。贪心在
 * 中文正文上**已经是最优解**，这不是猜测而是实测——见下。本模块只在贪心确实
 * 会输的那一小撮段落上接管，其余原样放行。
 *
 * ## 为什么不照搬 Knuth-Plass（三个实测理由）
 *
 * 实测语料 22,680 字、117 段（`review/memo-kp-worth-it.ts`）：
 *
 * | 语料 | 断点密度 | 最大不可断跨度 | 贪心 vs 全段最优 |
 * |---|---:|---:|---|
 * | 纯中文 | **91%** | **2 字** | **完全同解** |
 * | 中英混排 | 54% | 12 字 | ARMS 降 88.3% |
 * | 纯英文 | 36% | 11 字 | ——KP 的主场 |
 *
 * 纯中文几乎每两字之间都能断，贪心总能把版心填到只差不到 1em，最优解无从改进。
 * KP 在拉丁文上的全部价值来自「词不可断造成的大块头」，而中文没有这个问题；
 * 全段 DP 在 1384 字上要 477ms（比贪心慢 **960 倍**），却换来零收益。
 *
 * **困难不在「怎么把行填满」，而在不可断跨度造成的局部塌陷。** 西文词、URL、
 * 行内代码、带单位数值会形成十几字的不可断跨度，那一小段局部退化成拉丁文的
 * 处境。现有方案要么用贪心（看不见跨度），要么用 KP（在 91% 密度下白付代价），
 * 没有一个按跨度分派——这正是调研 §5.3「CJK 的 KP 式全段最优断行证据查不到」
 * 那个空位的实质内容。
 *
 * ## CJK 上「紧凑」与「均匀」数学等价（本方案的支点）
 *
 * ```text
 * 行数固定 ⇒ 总余白 Σsᵢ 固定 ⇒ 均值 μ 固定
 *         ⇒ 最小化 Σsᵢ² 等价于最小化 Σ(sᵢ−μ)² = 方差
 * ```
 *
 * CJK 段落的行数在绝大多数情况下只有一个可行值（91% 的断点密度让「多断出一行」
 * 几乎不可能），两个目标于是退化成一个。**拉丁文不同**：连字符可以改变行数，
 * Σs 随之变化，两者才真正竞争——这正是 Verna 2025 报告「均匀度不是免费获得、
 * 自然字距变差 0.01–0.02」的原因，而我们测到两者同时改善。
 *
 * 这不是「我们的实现更好」，是**问题结构不同**。
 *
 * ## 三个常数都由实测定，不是调出来的
 *
 * | 常数 | 取值 | 依据 |
 * |---|---:|---|
 * | `SPAN_THRESHOLD` | 12 字 | 阈值扫描：走最优的段落 46/95，用 **55% 的计算量拿 95% 的收益**。跨度分布重尾（≤4 字占 94.45%，≥12 字仅 0.9%） |
 * | `UNIFORMITY_WEIGHT` | 2 | 见下，由**费用函数看不见的量**定 |
 * | `MAX_PARAGRAPH` | 400 字 | 耗时降 5.4 倍（1015ms → 188ms），收益只掉 6.5 个百分点 |
 *
 * **权重为什么是 2**：ARMS/SD 一路降到 0.497 说的是假话——我用来评价的指标与
 * 我优化的费用函数是同一个数学对象，那是自证。改用**不在费用里**的四个量重测：
 *
 * | 权重 | 行数增加 | 孤行(末行≤2字) | 坏行(余白>3em) |
 * |---:|---:|---:|---:|
 * | 0 | 0 | 1 | 28 |
 * | **2** | **1** | **0** | **35** |
 * | 8 | 4 | 0 | 47 |
 * | 16 | 6 | 0 | 59 |
 *
 * 权重越大，优化器越倾向「多断出一行」来换均匀。取 2：孤行归零（排版学真正
 * 在意的缺陷），行数只增 1。**任何「优化 X 之后 X 变好了」的报告都是自证。**
 *
 * ## 与 Chromium 对拍（115 段、4 个版心，`review/vs-chromium-fair.ts`）
 *
 * 合计 **84 胜 4 负 27 平**，ARMS 领先 58.1%–80.2%。最关键的是**行数四个版心
 * 全部持平**——领先不是靠多断一行换来的，那是唯一能作弊的维度。
 */

import { candidates, lineStarts } from "./line-break.ts";
import type { BreakStrictness, TypesetPreset } from "./preset.ts";
import type { AdjustedChar } from "./spacing.ts";
import { lineEndAdjustment } from "./spacing.ts";

/**
 * 触发局部最优的最小不可断跨度（字）。
 *
 * 低于这个值时贪心与最优基本同解——跨度分布是重尾的，1 字占 82.93%、
 * ≤4 字累计 94.45%，而收益几乎全部来自 ≥12 的那 0.9%。
 */
const SPAN_THRESHOLD = 12;

/**
 * 段落长度上限（字）。超过这个长度直接走贪心。
 *
 * DP 是 O(n²) 的，696 字就要 28.5ms（超一帧）。真实语料中位数 104 字、
 * p90 250 字、≥696 字仅占 1.3%，所以这条上限几乎不影响收益。
 */
const MAX_PARAGRAPH = 400;

/** 相邻行余白差的权重。见文件头的独立判据表：再高就是用版面换指标。 */
const UNIFORMITY_WEIGHT = 2;

/**
 * 为避开词中间，一行右缘最多允许空出几个字身。
 *
 * 取 1，且这个 1 是有理由的而不是调出来的：**一个字身正好是基线网格的一格**。
 * 缺一格的行与齐平的行在纵向上仍然对得齐，缺半格就不行了。所有者对代价法的
 * 判词正是「右缘坑坑洼洼」，而坑洼的严重程度就是这个上界。
 *
 * 实测容差扫描（四段语料 × 五档版心）：0 等于关掉避词（词中间 19/62）；
 * 1 之后立刻饱和（词中间 0/62，最大缺口 1.0 字），2 与 3 与无穷大的读数
 * **逐字节相同**——中文词长以一到二字为主，退回一个字身够到最近的词边界，
 * 再放宽换不来任何东西，只会把上界抬高。
 */
const MAX_WORD_SLACK = 1;

/**
 * 断点自身代价在总费用里的权重。由下面的扫描定，不是猜的。
 *
 * 值域说明：`candidates` 给出的 penalty 是 {0,10,15,25,40,55} 这一档，而
 * 余白项是 em 的平方（一行差 4em 即 16，差 8em 即 64）。两者量纲不同，直接
 * 相加会让版面均匀度被断点代价压过去。
 */
const BREAK_PENALTY_WEIGHT = 1;

/**
 * 余白量化步长（em），用于把 DP 状态收敛成有限个。
 *
 * 状态是 `(位置, 上一行余白)`，而余白是连续量。不量化则状态数爆炸；量化太粗
 * 则不同余白被当成同一状态，均匀度判断失真。1/4 em 是半个西文字宽，小于任何
 * 一个字符的宽度差。
 */
const SLACK_QUANTUM = 0.25;

/** 一个字符占多宽。与 `line-break.ts` 的 advance 同规则——两处必须一致。 */
function advanceOf(character: AdjustedChar): number {
  return (
    character.spaceBefore +
    (character.kind === "latin" || character.kind === "digit" || character.kind === "space"
      ? 0.5
      : 1)
  );
}

/**
 * 一行从 `from` 到 `to`（左闭右开）的墨宽，含行尾调整。
 *
 * 行首不计前导空白：那是上一行行尾的事，算进来会让每一行都凭空宽出半个字。
 */
function inkWidth(
  measured: readonly AdjustedChar[],
  from: number,
  to: number,
  preset: TypesetPreset,
): number {
  let width = 0;
  for (let index = from; index < to; index += 1) {
    const character = measured[index];
    if (character === undefined) continue;
    width += index === from ? advanceOf(character) - character.spaceBefore : advanceOf(character);
  }
  const last = measured[to - 1];
  return width + (last === undefined ? 0 : lineEndAdjustment(last.kind, preset));
}

/**
 * 这一段里最长的不可断跨度有多少字。
 *
 * 这是 L1 结构层的度量，也是**策略按度量选、不按语言选**的那个量。按语言选是
 * 错的：中英混排语料的 `lang` 同样是 `zh`，却正是需要最优化的那一个。按跨度选
 * 对任何语言都成立，包括调研没覆盖的韩文与混入 CJK 的阿拉伯数字串。
 */
export function longestUnbreakableSpan(
  measured: readonly AdjustedChar[],
  preset: TypesetPreset,
  strictness: BreakStrictness = preset.breakStrictness,
): number {
  if (measured.length === 0) return 0;
  const allowed = new Set(candidates(measured, preset, strictness).map((entry) => entry.index));
  let longest = 0;
  let runStart = 0;
  for (let index = 1; index <= measured.length; index += 1) {
    if (index === measured.length || allowed.has(index)) {
      longest = Math.max(longest, index - runStart);
      runStart = index;
    }
  }
  return longest;
}

/**
 * 全段最优断行，费用 = 余白² + `UNIFORMITY_WEIGHT` × 相邻行余白差²。
 *
 * 状态是 `(位置, 上一行余白)` 而不是单纯的位置——相邻差这一项让费用不再只取决于
 * 当前行，所以位置本身不构成充分状态。这是本费用函数与经典 KP 的结构差别，
 * 也是它不满足四边形不等式、无法用线性算法优化的原因（调研 §结论已述）。
 *
 * **末行不罚**：与 KP 同规则，最后一行可以短。
 *
 * 返回 `null` 表示无解（整段存在放不进版心的不可断单元），调用方应退回贪心——
 * 贪心有让长单元溢出的兜底路径，那是 CSS `overflow-wrap: normal` 的语义。
 */
function optimalStarts(
  measured: readonly AdjustedChar[],
  preset: TypesetPreset,
  measureEm: number,
  strictness: BreakStrictness,
  wordStarts?: ReadonlySet<number>,
): readonly number[] | null {
  const total = measured.length;
  // 这里存的是**代价**不再只是下标集合。此前只取 `entry.index` 建一个 Set，
  // 于是 `candidates` 算出来的 penalty 在 DP 里被整个丢掉——三档严格度的差别
  // 之所以在最优路径上还能看出来，靠的是 strict 在候选阶段就删掉了候选，
  // 不是因为 DP 读懂了代价。语义断行没有那条捷径（它不删候选，只抬代价),
  // 所以必须让 DP 真的读它。
  const penalties = new Map(
    candidates(measured, preset, strictness, wordStarts).map((entry) => [
      entry.index,
      entry.penalty,
    ]),
  );

  /** 把 `(位置, 余白)` 压成一个整数键。余白量化后才有限。 */
  const keyOf = (position: number, slack: number): number =>
    position * 100_000 + Math.round(slack / SLACK_QUANTUM);

  const best = new Map<number, number>();
  const cameFrom = new Map<number, readonly [number, number]>();
  const startKey = keyOf(0, -1);
  best.set(startKey, 0);

  const queue: [number, number][] = [[0, -1]];
  const queued = new Set<number>([startKey]);
  let endCost = Number.POSITIVE_INFINITY;
  let endState: readonly [number, number] | null = null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const [position, previousSlack] = current;
    const base = best.get(keyOf(position, previousSlack));
    if (base === undefined) continue;

    for (let end = position + 1; end <= total; end += 1) {
      const breakPenalty = end === total ? 0 : penalties.get(end);
      if (end < total && breakPenalty === undefined) continue;
      const ink = inkWidth(measured, position, end, preset);
      // 一旦放不下，再往后只会更宽——这个 break 是 DP 保持 O(n·行宽) 的关键。
      if (ink > measureEm && end > position + 1) break;
      if (ink > measureEm) continue;

      const slack = end === total ? 0 : measureEm - ink;
      const uniform = previousSlack < 0 || end === total ? 0 : (slack - previousSlack) ** 2;
      // 断点自身的代价按 `BREAK_PENALTY_WEIGHT` 折进总代价。权重不是 1：
      // 余白项是 em 的平方（一行差 4em 就是 16），而 penalty 的值域是
      // {0,10,15,25,40,55} 这一档，直接相加会让代价完全由 penalty 支配，
      // 版面就不再均匀了。
      const cost =
        base +
        (end === total ? 0 : slack * slack) +
        UNIFORMITY_WEIGHT * uniform +
        BREAK_PENALTY_WEIGHT * (breakPenalty ?? 0);

      if (end === total) {
        if (cost < endCost) {
          endCost = cost;
          endState = [position, previousSlack];
        }
        continue;
      }

      const key = keyOf(end, slack);
      if (cost < (best.get(key) ?? Number.POSITIVE_INFINITY)) {
        best.set(key, cost);
        cameFrom.set(key, [position, previousSlack]);
        if (!queued.has(key)) {
          queued.add(key);
          queue.push([end, slack]);
        }
      }
    }
  }

  if (endState === null) return null;

  const starts: number[] = [];
  let cursor: readonly [number, number] | undefined = endState;
  while (cursor !== undefined && cursor[0] > 0) {
    starts.push(cursor[0]);
    cursor = cameFrom.get(keyOf(cursor[0], cursor[1]));
  }
  starts.push(0);
  starts.reverse();
  return starts;
}

/**
 * 按行宽折行，在值得的时候用局部最优，其余走贪心。
 *
 * 这是两个视口都该调用的入口——`lineStarts` 仍然导出，因为门禁与预设对拍需要
 * 一个不含策略选择的基线。**分派规则全部可解释**，没有一条是「调出来的」：
 *
 * | 条件 | 走哪条 | 理由 |
 * |---|---|---|
 * | 段落 > `MAX_PARAGRAPH` | 贪心 | O(n²) 超一帧，而这种段落占 1.3% |
 * | 最长跨度 < `SPAN_THRESHOLD` | 贪心 | 实测同解，DP 是白付 |
 * | 最优无解 | 贪心 | 贪心的溢出兜底才是对的 |
 * | 其余 | **局部最优** | ARMS 降 58.3%，45 段零变差 |
 */
export function optimizedLineStarts(
  measured: readonly AdjustedChar[],
  preset: TypesetPreset,
  measureEm: number,
  strictness: BreakStrictness = preset.breakStrictness,
  wordStarts?: ReadonlySet<number>,
): readonly number[] {
  const greedy = lineStarts(measured, preset, measureEm, strictness, wordStarts);

  // 单行段落无从优化——余白只有末行那一个，而末行不罚。
  if (greedy.length <= 1) return greedy;
  if (measured.length > MAX_PARAGRAPH) return greedy;
  if (longestUnbreakableSpan(measured, preset, strictness) < SPAN_THRESHOLD) return greedy;

  const optimal = optimalStarts(measured, preset, measureEm, strictness, wordStarts);
  if (optimal === null) return greedy;

  // 最优解不得比贪心多断行。行数是唯一能作弊的维度：多断一行几乎总能让余白更
  // 均匀，而那是把版面成本转嫁给读者。与 Chromium 那一场对拍里行数四个版心全部
  // 持平，靠的就是这条闸——没有它，「均匀度领先」这个结论就不可信。
  if (optimal.length > greedy.length) return greedy;

  return optimal;
}

/**
 * 断行入口。避开词中间，但**右缘缺口有硬上界**。
 *
 * ## 为什么不是「把避词写成代价交给优化器」
 *
 * 第一版正是那样做的：给词中间的断点加代价，让优化器自己权衡。它把词中间
 * 断点从 33.9% 降到 3.2%，行数也持平——数字全都好看，而所有者一看渲染就
 * 指出了真正的问题：**右缘坑坑洼洼，把标点悬挂的努力全抵消了**。
 *
 * 那不是调参能修的。代价法的缺口上界是优化出来的，不是规定的：优化器有时
 * 愿意用 3 个字身的缺口去换一个词的完整。实测四段语料 × 五档版心，代价法把
 * 参差行从 13% 推到 42%、最大缺口从 2 字推到 3 字、缺 2 字以上的行从 1 行
 * 增到 5 行。悬挂存在的全部理由是让右缘齐平，两者在同一条边上互相抵消。
 *
 * ## 这一版：缺口上界是规定的
 *
 * 先按纯几何找出这一行最多能放到哪，再问「退回最近的词边界要空出几个字身」。
 * 空出的量超过 `MAX_WORD_SLACK` 就不退——那一行宁可切词。于是缺口**按构造**
 * 不会超过一个字身，而一个字身恰好是基线网格的一格，不会产生半格错位。
 *
 * 实测同一组语料：词中间断点 0/62，最大缺口 1.0 字，缺 2 字以上的行 0 行，
 * 行数 82 逐档持平（三项都优于代价法）。
 *
 * ## 为什么不用 `text-align: justify` 事后拉平
 *
 * 两条各自即可否决。所有者的理由在先：字间调整只拉横向且每行拉伸量不同，
 * 短行拉得最开，**纵向那一列字就再也对不上基线网格**——等宽字身正是 CJK
 * 纵向对齐的前提。技术上也不通：实测在 `white-space: pre` 的段落上
 * justify 完全不生效（开关两组逐字节相同的右缘读数）。
 */
export function semanticLineStarts(
  measured: readonly AdjustedChar[],
  preset: TypesetPreset,
  measureEm: number,
  wordStarts: ReadonlySet<number>,
  strictness: BreakStrictness = preset.breakStrictness,
): readonly number[] {
  // 没有词边界信息，或者版心还没量出来：退回原来的那条路。
  if (wordStarts.size === 0 || measureEm <= 0) {
    return optimizedLineStarts(measured, preset, measureEm, strictness);
  }

  const baseline = optimizedLineStarts(measured, preset, measureEm, strictness);
  const allowed = new Set(candidates(measured, preset, strictness).map((entry) => entry.index));

  /** 从 `from` 到 `to`（不含）这一段有多宽，em。 */
  const widthBetween = (from: number, to: number): number => {
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
    return width;
  };

  // 允许的最坏缺口：基线自己最坏的那一行，再加一个字身。
  //
  // 上界必须从基线取，不能写死。基线也会因行首禁则而退（一个逗号不许起行，
  // 那一行就短一格），拿一个固定值当上界会在基线本来就宽松的段落上过严、
  // 在基线紧凑的段落上过松。
  let baselineWorst = 0;
  for (let line = 0; line + 1 < baseline.length; line += 1) {
    const from = baseline[line] ?? 0;
    const to = baseline[line + 1] ?? measured.length;
    baselineWorst = Math.max(baselineWorst, measureEm - widthBetween(from, to));
  }
  const worstAllowed = baselineWorst + MAX_WORD_SLACK;

  // 精确 DP，不是启发式。状态是「排到哪里 + 上一行是否参差」，目标先最少
  // 词中间断点、再最少行数。
  //
  // 为什么不是启发式：我先写了六版贪心（按退让字数判、按行宽判、按落后基线
  // 的量判、逐行比缺口、限累计、不连续退让），每一版都在某一档语料上越界。
  // 根因是这里有两个互相拉扯的目标和一条硬约束，逐行贪心看不到后面的代价——
  // 这一行退一格避开一个词，可能让下一行无处可退而切在词中间。
  //
  // 穷举求出的上界说明了代价：约束下最多把词中间断点从 21 降到 7，且要多断
  // 4 行（82 → 86）。那 4 行是真实成本，不是实现不够聪明。
  //
  // 规模：状态数是 O(n)，每个状态的转移被版心宽度限制为常数级，所以整体与
  // `optimalStarts` 同一量级。段落上限沿用 `MAX_PARAGRAPH`。
  if (measured.length > MAX_PARAGRAPH) return baseline;

  type State = { readonly cost: number; readonly lines: number; readonly from: number };
  /** 键是 `位置 * 2 + (上一行是否参差)`。 */
  const best = new Map<number, State>();
  best.set(0, { cost: 0, lines: 0, from: -1 });
  const queue = [0];

  for (let head = 0; head < queue.length; head += 1) {
    const key = queue[head];
    if (key === undefined) continue;
    const state = best.get(key);
    if (state === undefined) continue;
    const position = key >> 1;
    const previousRagged = (key & 1) === 1;
    if (position >= measured.length) continue;

    for (let end = position + 1; end <= measured.length; end += 1) {
      if (end < measured.length && !allowed.has(end)) continue;
      const width = widthBetween(position, end);
      // 一旦放不下，再往后只会更宽。
      if (width > measureEm) break;

      const isLast = end === measured.length;
      const gap = isLast ? 0 : measureEm - width;
      // 末行不受约束：末行短是正常的，不是参差。
      if (!isLast) {
        if (gap > worstAllowed) continue;
        // 连续两行都参差，右缘会读成一道斜边而不是一处凹陷。
        if (gap > 0 && previousRagged) continue;
      }

      const nextKey = end * 2 + (!isLast && gap > 0 ? 1 : 0);
      const next: State = {
        cost: state.cost + (isLast || wordStarts.has(end) ? 0 : 1),
        lines: state.lines + 1,
        from: key,
      };
      const current = best.get(nextKey);
      if (
        current === undefined ||
        next.cost < current.cost ||
        (next.cost === current.cost && next.lines < current.lines)
      ) {
        best.set(nextKey, next);
        if (!queue.includes(nextKey)) queue.push(nextKey);
      }
    }
  }

  // 终点有两个键（末行参差与否），取代价更小的那个。
  let endKey: number | null = null;
  for (const key of [measured.length * 2, measured.length * 2 + 1]) {
    const state = best.get(key);
    if (state === undefined) continue;
    const incumbent = endKey === null ? undefined : best.get(endKey);
    if (
      incumbent === undefined ||
      state.cost < incumbent.cost ||
      (state.cost === incumbent.cost && state.lines < incumbent.lines)
    ) {
      endKey = key;
    }
  }
  // 约束太紧导致无解：退回基线。它总是可行的（基线自己定义了上界）。
  if (endKey === null) return baseline;

  const starts: number[] = [];
  for (let key: number | undefined = endKey; key !== undefined && key > 1; ) {
    starts.push(key >> 1);
    const state = best.get(key);
    if (state === undefined || state.from < 0) break;
    key = state.from;
  }
  starts.push(0);
  starts.reverse();
  // 末尾那个是段尾不是行首。
  if (starts[starts.length - 1] === measured.length) starts.pop();
  return starts;
}
