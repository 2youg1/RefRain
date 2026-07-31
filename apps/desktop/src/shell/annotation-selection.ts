/** Author intent that persists when the annotation panel is hidden or unmounted. */

/** 一条批注在这次选择里的身份。只需要 id，其余从投影里读。 */
export type AnnotationId = string;

export class AnnotationSelection {
  #selected: ReadonlySet<AnnotationId> = new Set();

  constructor(private readonly announce: () => void) {}

  get selected(): ReadonlySet<AnnotationId> {
    return this.#selected;
  }

  get count(): number {
    return this.#selected.size;
  }

  has(id: AnnotationId): boolean {
    return this.#selected.has(id);
  }

  /** 勾上或取消。同一个按键两种意思，因为作者看到的就是一个复选框。 */
  toggle(id: AnnotationId): void {
    const next = new Set(this.#selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.#set(next);
  }

  /** Clear after dispatch consumes the selection. */
  clear(): void {
    if (this.#selected.size === 0) return;
    this.#set(new Set());
  }

  /** Remove deleted annotations and announce only when the selection changes. */
  retain(alive: Iterable<AnnotationId>): void {
    const living = new Set(alive);
    const next = new Set([...this.#selected].filter((id) => living.has(id)));
    if (next.size === this.#selected.size) return;
    this.#set(next);
  }

  #set(next: ReadonlySet<AnnotationId>): void {
    this.#selected = next;
    this.announce();
  }
}
