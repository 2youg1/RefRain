/**
 * 就地 diff：把一次改动在原文里标出来，而不是弹一个并列面板。
 *
 * ## 两种模式的形态由 KL9 2026-08-01 定
 *
 * | 模式 | 渲染 |
 * |---|---|
 * | **普通模式** | 就地 diff——增删都标出来，看得见改了什么 |
 * | **Kara** | **接受改动，直接渲染改动后的状态**做对比，不堆叠增删标记 |
 *
 * Kara **不是不显示改动**，它照常接受智能体的改动；区别在于呈现方式。
 * 编辑模式那套 VS Code 式的 `+++` 绿 / `---` 红，会让同一处文本同时挂着
 * 旧行与新行，颜色堆叠而且行数被删除行占位撑开。Kara 渲染的是**改动后的
 * 成品**：读到的是干净的新文本，对比通过「呈现结果」而非「标注差异」完成。
 *
 * 这样颜色不堆叠、行数不跳动，长时间专注修改时版面是安定的。视觉扰动的每
 * 一次发生都是一次注意力消耗，而 Kara 存在的理由正是把它降到最低。
 *
 * 与状态机既有语义一致：`ProposalArrived` 本就是 `QuietEvent`，Kara 期间入队
 * 等 debrief 而不弹出——同一条原则的另一处体现。
 *
 * ## 为什么 diff 算在这一层
 *
 * 它是纯函数：两个字符串进，一组区间出。放在零依赖零 DOM 的 typeset 里，
 * 预览视口、服务端渲染与将来的 PDF 导出可以用同一份判定——「哪里改了」是
 * 文本事实，不是某个视口的私事。
 *
 * ## 颜色不进文本
 *
 * 本模块只输出**区间下标**，一个字符也不产出。着色由渲染层用元素属性完成，
 * 磁盘字节、Source Backup、复制文本全都不受影响。`verify:byte-invariance`
 * 守着这条。
 */

/** 一段文本相对另一段的差异区间，左闭右开，按 UTF-16 下标。 */
export interface DiffSpan {
  readonly start: number;
  readonly end: number;
  /** `added` 是新文本里多出来的；`removed` 记的是旧文本里被删掉的位置。 */
  readonly kind: "added" | "removed";
}

/**
 * 呈现模式：决定同一份 diff 判定被画成什么。
 *
 * 判定只算一次，两种模式读同一份结果——**不是两套 diff 逻辑**。若各算各的，
 * 同一处改动在两个模式下可能标出不同的范围，而那种不一致没有任何东西会报错。
 */
export type DiffPresentation = "marks" | "result";

/**
 * 按呈现模式过滤 diff 区间。
 *
 * - `marks`（普通模式）：增删都要。作者在比较，删除标记是信息。
 * - `result`（Kara）：只留 `added`。删除标记是一个零宽记号，它不承载新文本
 *   却要占一处视觉位置——那正是 Kara 要消除的扰动。被删掉的内容在改动后的
 *   文本里本来就不存在，「直接渲染改动后的状态」意味着它不该再出现。
 */
export function forPresentation(
  spans: readonly DiffSpan[],
  presentation: DiffPresentation,
): readonly DiffSpan[] {
  return presentation === "marks" ? spans : spans.filter((span) => span.kind === "added");
}

/**
 * 找出 `before` 与 `after` 的差异区间。
 *
 * ## 为什么是「公共前后缀」而不是完整的 LCS
 *
 * 完整最长公共子序列是 O(n×m)，而这里的输入是**一次编辑的前后**——作者或
 * 智能体改的是句中一处、一个词、一段话，前后缀几乎总是大段相同。剥掉公共
 * 前后缀之后剩下的就是改动本身，一次线性扫描即可，不必为一个几乎不出现的
 * 一般情形付平方代价。
 *
 * 代价是「中间又插又删」时会把整段标成一处而不是分开标几处。对着色来说这是
 * 对的粒度：作者要看的是「这里变了」，把一句话拆成七个碎片区间反而更难读。
 *
 * ## 按码位对齐，不按 UTF-16 格
 *
 * 前后缀比较必须落在码位边界上，否则 emoji 与增补平面汉字会被从代理对中间
 * 切开，产出两个坏字符的区间。返回的下标仍是 UTF-16 的——DOM 的 Range 与
 * `textContent` 用的就是那个坐标系。
 */
export function diffSpans(before: string, after: string): readonly DiffSpan[] {
  if (before === after) return [];

  const beforePoints = [...before];
  const afterPoints = [...after];

  // 公共前缀：按码位比，逐个累加 UTF-16 长度。
  let prefix = 0;
  let prefixUnits = 0;
  while (
    prefix < beforePoints.length &&
    prefix < afterPoints.length &&
    beforePoints[prefix] === afterPoints[prefix]
  ) {
    prefixUnits += (afterPoints[prefix] ?? "").length;
    prefix += 1;
  }

  // 公共后缀：不得与前缀重叠，否则 `aa` → `aaa` 这类会数重。
  let suffix = 0;
  let suffixUnits = 0;
  while (
    suffix < beforePoints.length - prefix &&
    suffix < afterPoints.length - prefix &&
    beforePoints[beforePoints.length - 1 - suffix] === afterPoints[afterPoints.length - 1 - suffix]
  ) {
    suffixUnits += (afterPoints[afterPoints.length - 1 - suffix] ?? "").length;
    suffix += 1;
  }

  const spans: DiffSpan[] = [];
  const addedPoints = afterPoints.length - prefix - suffix;
  const removedPoints = beforePoints.length - prefix - suffix;

  if (addedPoints > 0) {
    spans.push({
      start: prefixUnits,
      end: after.length - suffixUnits,
      kind: "added",
    });
  }
  if (removedPoints > 0 && addedPoints === 0) {
    // 纯删除没有可着色的新文本。标一个零宽区间，渲染层据此画一个删除记号——
    // 不标的话「这里删掉了一句话」在版面上完全看不见，而那正是作者最需要
    // 知道的一类改动。
    spans.push({ start: prefixUnits, end: prefixUnits, kind: "removed" });
  }

  return spans;
}

/**
 * 着色的衰减档位。
 *
 * 颜色**必须消退**：改过二十次的稿子若每处都永久着色，版面会变成花的，
 * 而那时颜色不再指示任何东西——它标出的是「这份稿子被改过」，一句作者早就
 * 知道的话。
 *
 * 分三档而不是连续插值：连续变化意味着每一帧都要重画，那本身就是 Kara 要
 * 消除的那种视觉扰动，而且它让「刚改的」与「改了一会儿的」之间没有可辨认的
 * 界限。三档给出三个可辨认的状态，最后归零。
 */
export type DiffAge = "fresh" | "settling" | "faded";

/** 一处改动多久之后进入下一档（毫秒）。 */
const FRESH_MS = 8_000;
const SETTLING_MS = 30_000;

/**
 * 一处改动此刻该是哪一档；`null` 表示已经完全消退，不再着色。
 *
 * 传入 `now` 而不是在函数里读时钟：纯函数才能被断言。读时钟的版本要么在
 * 测试里睡三十秒，要么去 mock 全局时间——两条路都比多传一个参数贵。
 */
export function diffAge(changedAt: number, now: number): DiffAge | null {
  const elapsed = now - changedAt;
  if (elapsed < 0) return "fresh";
  if (elapsed < FRESH_MS) return "fresh";
  if (elapsed < SETTLING_MS) return "settling";
  return null;
}
