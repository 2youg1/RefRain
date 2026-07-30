import type { EditorContext } from "@refrain/editor";
import type { AnnotationDto } from "../generated/bindings.gen";

/**
 * 从右键落点到一次派发之间的那条链。
 *
 * 作者在正文上右键，可能走向三个去处：把这一段送去派发、把选中的字变成高亮或
 * 批注、或者把某条批注迁到别处。这三件事此前各自散在外壳里，共用一个 `menu`
 * 可空字段和一个 `dispatchSeed` 数组，谁清谁全看调用次序。
 *
 * 收进来的理由不是行数，是**规矩**：右键菜单必须在意图落定后关闭（否则菜单浮在
 * 已经变了的正文上）、派发种子必须去重（同一段落被点两次不该派发两遍）、
 * 迁移中的批注在落点确定前必须一直被记住。这些是「一次编辑意图」这个概念自身的
 * 性质，不是外壳的编排。
 */

export interface Pointer {
  readonly context: EditorContext;
  readonly x: number;
  readonly y: number;
}

/** 派发要带走的东西：一组块，和作者写给 Agent 的话。 */
export interface DispatchSeed {
  readonly blockIds: readonly string[];
  readonly prompt: string;
}

const EMPTY: DispatchSeed = { blockIds: [], prompt: "" };

export class EditIntents {
  #pointer: Pointer | null = null;
  #seed: DispatchSeed = EMPTY;

  constructor(private readonly announce: () => void) {}

  get pointer(): Pointer | null {
    return this.#pointer;
  }

  get seed(): DispatchSeed {
    return this.#seed;
  }

  /** 正文上的一次右键。 */
  aim(context: EditorContext, x: number, y: number): void {
    this.#pointer = { context, x, y };
    this.announce();
  }

  /** 收起菜单。意图落定、按下 Escape、点到别处，都走这里。 */
  release(): void {
    if (this.#pointer === null) return;
    this.#pointer = null;
    this.announce();
  }

  /**
   * 把右键落中的那一段送去派发。
   *
   * `accumulate` 是「加入派发」而非「派发此段」：前者攒一批，后者从这一段重来。
   * 两条路都会去重——作者把同一段点两次，Agent 不该收到它两遍。
   */
  dispatchAimedBlock(accumulate: boolean): boolean {
    const pointer = this.#pointer;
    if (pointer === null) return false;
    const blockId = pointer.context.blockId;
    const blockIds = accumulate ? [...this.#seed.blockIds, blockId] : [blockId];
    this.#seed = { blockIds: [...new Set(blockIds)], prompt: this.#seed.prompt };
    this.release();
    return true;
  }

  /** 从批注面板发起的派发：批注自带一句话，块由批注给出。 */
  dispatchAnnotations(blockIds: readonly string[], prompt: string): void {
    this.#seed = { blockIds: [...new Set(blockIds)], prompt };
    this.announce();
  }

  /**
   * 一次批注写入需要的全部材料。
   *
   * 返回 null 表示这次右键落在没有选区的地方——高亮与批注都锚在选中的字上，
   * 没有选区就没有可锚之处，这不是失败，界面上什么都不该发生。
   */
  annotationTarget(existing: AnnotationDto | null): {
    readonly blockId: string;
    readonly start: number;
    readonly end: number;
    readonly quote: string;
    readonly id: string | null;
  } | null {
    const selection = this.#pointer?.context.selection;
    if (this.#pointer === null || selection === null || selection === undefined) return null;
    return {
      blockId: this.#pointer.context.blockId,
      start: selection.start,
      end: selection.end,
      quote: selection.quote,
      id: existing?.id ?? null,
    };
  }
}
