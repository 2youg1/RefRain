/**
 * 改动着色：外部改到稿子上的每一处，在原地标出来，然后消退。
 *
 * ## 这一层拥有什么
 *
 * 一份「此刻哪些区间该着色」的状态，以及它随时间的推进。判定本身不在这里
 * ——`@refrain/typeset` 的 `diffSpans` / `forPresentation` / `diffAge` 是纯
 * 函数，服务端渲染与预览视口用的是同一份。这一层做的是把那些纯函数接到
 * 一个有时间、有块 id、有生灭的宿主上。
 *
 * ## 为什么外部改动与作者自己的编辑不需要标志位区分
 *
 * 视图的 `#submit` 在提交那一刻就调 `applyLocally` 把作者的改动落进投影，
 * 所以当领域确认回来、`replace(blocks)` 到达时，作者敲过的那些块**新旧文本
 * 完全相同**，`diffSpans` 按构造返回空数组。只有智能体提案落地、或外部改了
 * 文件，才会出现两边不同的块。
 *
 * 加一个「这次改动来自谁」的标志位是可以的，但那会造出第二个权威：标志位说
 * 一套、文本比对说另一套时，没有任何东西会报错。这里选择让判据只有一个。
 *
 * ## 为什么颜色用 CSS Custom Highlight 而不是 span
 *
 * 段落里已经住着两种元素：混排间距的空元素、代码围栏的着色 span。再插一层
 * diff 的 span 意味着三者要互相嵌套，而它们的区间互不对齐（间距按码位边界、
 * 围栏按词法单元、diff 按改动范围）。Highlight API 画在 Range 上，一个字符
 * 也不进 DOM，三者因此互不相干，磁盘字节与 `textContent` 同样不受影响。
 *
 * 这也是批注（`#projectAnnotations`）走的路——同一个机制不该有两套用法。
 */

import {
  type DiffPresentation,
  type DiffSpan,
  diffAge,
  diffSpans,
  forPresentation,
} from "@refrain/typeset";
import type { Block } from "./model";

/**
 * 新增文本的 Highlight 注册名。渲染层的 CSS 与门禁都引用这个常量。
 *
 * 删除**没有**对应的注册名：纯删除的区间是零宽的，而零宽 Range 上 Highlight
 * 画不出任何像素（实测，`e2e/probe-zero-width-highlight.ts`）。删除改由段落上
 * 的 `data-changed="removed"` 标出。
 */
export const ADDED_HIGHLIGHT = "refrain-diff-added";

/** 一个块上一处待消退的改动：改在哪里，以及什么时候改的。 */
interface BlockChange {
  readonly spans: readonly DiffSpan[];
  readonly changedAt: number;
}

/**
 * 一份稿子上「哪里刚被改过」的账。
 *
 * 只存区间与时刻，不存文本——文本的权威是块本身，这里再存一份就会漂。
 */
export class ChangeHighlights {
  readonly #changes = new Map<string, BlockChange>();
  #presentation: DiffPresentation = "marks";

  /**
   * 用新旧两版块记下这一次改动。
   *
   * 只比对 id 相同的块。新出现的块与消失的块不着色：那是结构改动，把整段
   * 新增的段落通篇染色只会淹没真正的改动在哪一处。
   *
   * 不写 `old === block.text` 的短路：`diffSpans` 对相同文本本来就返回空数组，
   * 那行守卫删掉之后行为逐字不变——注入实测九条断言全绿。一条无法失效的守卫
   * 读起来像在防什么，实际什么也没防，而下一个人会以为「相同文本」这个情形
   * 是靠它挡住的。真正挡住它的是 `diffSpans`，让判据只留在那一处。
   */
  observe(previous: readonly Block[], next: readonly Block[], now: number): void {
    const before = new Map(previous.map((block) => [block.id, block.text]));
    for (const block of next) {
      const old = before.get(block.id);
      if (old === undefined) continue;
      const spans = diffSpans(old, block.text);
      if (spans.length > 0) this.#changes.set(block.id, { spans, changedAt: now });
    }
  }

  /** 换呈现模式。判定不重算——两种模式读的是同一份账。 */
  setPresentation(presentation: DiffPresentation): void {
    this.#presentation = presentation;
  }

  presentation(): DiffPresentation {
    return this.#presentation;
  }

  /** 一处改动也没有：调用方据此走「什么都不用画」的快路径。 */
  isEmpty(): boolean {
    return this.#changes.size === 0;
  }

  /** 稿子换了、编辑器重挂时清空。旧稿的改动记录对新稿没有意义。 */
  clear(): void {
    this.#changes.clear();
  }

  /**
   * 此刻该着色的区间，按块分组。
   *
   * 顺带把已经完全消退的块从账上删掉：不删的话一份长时间编辑的稿子会累积出
   * 成千上万条早已不着色的记录，而它们每一帧都要被遍历一次。
   */
  current(now: number): Map<string, readonly DiffSpan[]> {
    const live = new Map<string, readonly DiffSpan[]>();
    for (const [id, change] of [...this.#changes]) {
      if (diffAge(change.changedAt, now) === null) {
        this.#changes.delete(id);
        continue;
      }
      const spans = forPresentation(change.spans, this.#presentation);
      if (spans.length > 0) live.set(id, spans);
    }
    return live;
  }
}
