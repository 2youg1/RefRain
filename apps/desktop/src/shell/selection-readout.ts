/**
 * 选中量度的观察：编辑器换了就换一份观察。
 *
 * 组件本来可以直接持有 `stopSelectionMeasure` 这个句柄，但那会让「换文档时
 * 要先停掉旧的观察」这条顺序约束住在组件里——而组件是最容易被下一个人加一行
 * 就打破它的地方。收进这里之后，调用方只需要说「现在的编辑器是这个」。
 */
import type { SelectionMeasure } from "@refrain/editor";

export interface SelectionSource {
  onSelectionMeasured(listener: (measure: SelectionMeasure | null) => void): () => void;
}

export class SelectionReadout {
  readonly #emit: (measure: SelectionMeasure | null) => void;
  #stop: (() => void) | null = null;

  constructor(emit: (measure: SelectionMeasure | null) => void) {
    this.#emit = emit;
  }

  /** 换一个编辑器（或 null 表示没有）。旧观察在此停止。 */
  observe(source: SelectionSource | null): void {
    this.#stop?.();
    this.#stop = null;
    this.#emit(null);
    if (source !== null) this.#stop = source.onSelectionMeasured(this.#emit);
  }

  destroy(): void {
    this.observe(null);
  }
}
