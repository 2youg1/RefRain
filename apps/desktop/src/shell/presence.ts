/**
 * 离场需要一段时间：可见性已经过去，但节点还要多活一个动画的长度。
 *
 * 没有这层，Solid 的 `<Show>` 在条件翻转的同一帧拆掉节点，「关掉」永远是一刀切——
 * 设计要求的关闭动画（收拢、淡出）根本没有机会被看见。
 *
 * 计时器不在这里自己造：与 rail-presence 同一个道理，测试要能够不等待地走完时间。
 */

export interface Clock {
  setTimeout: (task: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

export const browserClock: Clock = {
  setTimeout: (task, ms) => window.setTimeout(task, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export class Presence {
  #shown = false;
  #leaving = false;
  #timer: number | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly exitMs: number,
    private readonly announce: () => void,
  ) {}

  /** 此刻该不该渲染：可见，或正在离场。 */
  get shown(): boolean {
    return this.#shown;
  }

  /** 正在离场——渲染层据此换关闭动画的 class。 */
  get leaving(): boolean {
    return this.#leaving;
  }

  /** 可见性变了。true 立即出现；false 进入离场窗，走完才消失。 */
  update(visible: boolean): void {
    if (visible) {
      if (this.#timer !== null) {
        this.clock.clearTimeout(this.#timer);
        this.#timer = null;
      }
      if (!this.#shown || this.#leaving) {
        this.#shown = true;
        this.#leaving = false;
        this.announce();
      }
      return;
    }
    if (!this.#shown || this.#leaving) return;
    this.#leaving = true;
    this.announce();
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null;
      this.#shown = false;
      this.#leaving = false;
      this.announce();
    }, this.exitMs);
  }

  dispose(): void {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
