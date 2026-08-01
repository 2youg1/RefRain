/**
 * 行内 Markdown 标记的渲染侧解析：这一块内部哪些字节该画粗、画斜、画等宽。
 *
 * # 与另外两份「同类」代码的分工
 *
 * 仓库里有三处在处理同一套行内语法。它们不是重复——三个不同的问题，各自的
 * 出口类型就是它们不能合并的证据：
 *
 * | 模块 | 问题 | 出口 |
 * |---|---|---|
 * | 这里 | 「这一块该怎么画」 | 扁平切片，标记符留着画淡 |
 * | `refrain-core::inline_span`（Rust） | 「索引该收什么」 | 去掉标记符的纯文本 |
 * | `inline-mark.ts` | 「按 Ctrl+B 时这个选区改写成什么」 | 新的源文本 + 新选区 |
 *
 * **为什么渲染这一份必须在 TypeScript 而不是复用 Rust 那份**：`#paintText` 之后
 * 紧跟 `placeCaret` 同步执行。走 Tauri 是异步 IPC，光标会在标记重算完成前落位
 * ——作者每敲一个字光标闪跳一次。而索引那一份跑在 Rust 的 SQLite 事务里，
 * 那里没有 JavaScript 运行时。两边都没有选择。
 *
 * 两份实现不共享代码但**必须给出一致的判定**，否则作者会看到「屏幕上是粗体、
 * 搜索却按字面匹配」。`test/inline-render-parity.test.ts` 用同一批语料对拍。
 *
 * # 标记符不隐藏
 *
 * 字节即正本。`**` 留在正文里只是画淡（`--ink-faint`），不是摘掉。于是屏幕上的
 * 字符序与源码字节序始终一一对应，光标定位（`locateOffset` 数 `textContent`
 * 长度）、断行的字符数组、改动着色的区间账本全部不必换算。隐藏字符要付的是
 * 「源码偏移 ↔ 显示偏移」双坐标系，四处都要改且每处漂开都表现为光标跳位。
 */

/** 一段字节带的样式。与 Rust 侧 `InlineStyle` 逐项对应。 */
export type InlineStyle = "strong" | "emphasis" | "code" | "strikethrough";

/** 一段带样式的字符区间，`start..end` 半开，下标按 UTF-16 码元。 */
export interface InlineSpan {
  readonly start: number;
  readonly end: number;
  readonly style: InlineStyle;
  /** 内容区间（不含标记符）。视图层据此决定哪些字符加粗、哪些画淡。 */
  readonly contentStart: number;
  readonly contentEnd: number;
}

/** 从 `at` 起连续多少个 `character`。 */
function runLength(text: string, at: number, character: string): number {
  let length = 0;
  while (at + length < text.length && text[at + length] === character) length += 1;
  return length;
}

/** 从 `from` 起找到下一处至少 `want` 个连续 `character` 的位置。 */
function findRun(text: string, from: number, character: string, want: number): number | null {
  let index = from;
  while (index < text.length) {
    if (text[index] === character) {
      const run = runLength(text, index, character);
      if (run >= want) return index;
      index += run;
    } else {
      index += 1;
    }
  }
  return null;
}

/**
 * 解析一段正文里的行内标记。
 *
 * 返回的区间按 `start` 升序且互不重叠——重叠的标记只保留最外层能配对的那个，
 * 因为扁平结构表达不了「同一个字符属于两个样式」。
 *
 * 围栏代码块不该走到这里：整块由语法高亮负责，行内解析会把代码里的星号
 * 误判为强调。
 */
export function inlineSpans(text: string): readonly InlineSpan[] {
  const spans: InlineSpan[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? "";

    // 反引号优先于其余一切。CommonMark §6.1：代码区间的边界先于强调判定，
    // 所以 `*` 落在反引号里就只是一个星号。先扫它才能让这条成立。
    if (character === "`") {
      const fence = runLength(text, index, "`");
      const close = findRun(text, index + fence, "`", fence);
      if (close !== null && close > index + fence) {
        spans.push({
          start: index,
          end: close + fence,
          style: "code",
          contentStart: index + fence,
          contentEnd: close,
        });
        index = close + fence;
        continue;
      }
      index += fence;
      continue;
    }

    if (character === "~") {
      const run = runLength(text, index, "~");
      if (run >= 2) {
        const close = findRun(text, index + run, "~", 2);
        if (close !== null && close > index + run) {
          spans.push({
            start: index,
            end: close + 2,
            style: "strikethrough",
            contentStart: index + 2,
            contentEnd: close,
          });
          index = close + 2;
          continue;
        }
      }
      index += run;
      continue;
    }

    if (character === "*" || character === "_") {
      const run = runLength(text, index, character);
      // 两个标记符是强调；三个以上取 strong——不做嵌套，而 strong 是更强的
      // 那个信号，作者写 `***` 要的是「非常强调」。
      const want = run >= 2 ? 2 : 1;
      const close = findRun(text, index + run, character, want);
      // 内容不能为空：`****` 不是一个空的加粗，它是四个星号。
      if (close !== null && close > index + run) {
        // 收尾吃掉多少个标记符，取决于收尾那一串真有多少个，不是 `want`。
        // `***很强***` 的收尾是三个星号，只吃两个会在区间外留下一个孤立的
        // `*`，视图层于是把它当正文画出来——屏幕上多一个星号。
        const closing = Math.min(runLength(text, close, character), run);
        spans.push({
          start: index,
          end: close + closing,
          style: want === 2 ? "strong" : "emphasis",
          contentStart: index + run,
          contentEnd: close,
        });
        index = close + closing;
        continue;
      }
      index += run;
      continue;
    }

    index += 1;
  }

  return spans;
}

/**
 * 把标记区间切成不跨越 `boundaries` 的片段。
 *
 * 断行与混排间距已经把这一块切成若干 run，而标记区间会**横跨**那些切点：
 * 一段跨行的加粗必须在换行处断开，否则加粗的 DOM 元素会包住换行元素。
 * 合成的办法是把两套切点并成一个有序集合，每片各自带样式——扁平，不嵌套。
 *
 * `boundaries` 是既有的 run 边界（累计下标），`text.length` 不必包含在内。
 */
export function sliceByBoundaries(
  text: string,
  spans: readonly InlineSpan[],
  boundaries: readonly number[],
): readonly { text: string; style: InlineStyle | null; start: number }[] {
  const cuts = new Set<number>([0, text.length]);
  for (const boundary of boundaries) {
    if (boundary > 0 && boundary < text.length) cuts.add(boundary);
  }
  for (const span of spans) {
    cuts.add(span.start);
    cuts.add(span.end);
  }
  const ordered = [...cuts].sort((left, right) => left - right);

  const pieces: { text: string; style: InlineStyle | null; start: number }[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index] as number;
    const to = ordered[index + 1] as number;
    if (from === to) continue;
    const owner = spans.find((span) => span.start <= from && to <= span.end);
    pieces.push({ text: text.slice(from, to), style: owner?.style ?? null, start: from });
  }
  return pieces;
}

/**
 * 这个字符下标是不是标记符本身（而非被标记的内容）。
 *
 * 视图层据此把标记符画淡：内容用正文墨色加粗，标记符退到 `--ink-faint`。
 * 判定放在这里而不是让视图层比较四个下标，是因为「哪些字节是标记符」是这个
 * 模块的知识——视图层只该问「这个字符要不要画淡」。
 */
export function isMarkerAt(spans: readonly InlineSpan[], index: number): boolean {
  return spans.some(
    (span) =>
      (index >= span.start && index < span.contentStart) ||
      (index >= span.contentEnd && index < span.end),
  );
}
