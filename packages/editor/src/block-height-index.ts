/**
 * Maintain logical block heights for the editor's virtual window.
 *
 * The DOM measures only mounted blocks. Two Fenwick trees store measured
 * heights and measured counts. Unknown blocks use one shared estimate. This
 * keeps spacer sums and scroll lookup local without making DOM nodes a second
 * text authority.
 */
export class BlockHeightIndex {
  readonly #heights: Float64Array;
  readonly #sumTree: Float64Array;
  readonly #knownTree: Uint32Array;
  #estimate: number;
  #measuredTotal = 0;
  #measuredCount = 0;

  constructor(heights: readonly number[]);
  constructor(length: number, estimate: number);
  constructor(heightsOrLength: readonly number[] | number, estimate = 40) {
    if (typeof heightsOrLength === "number") {
      const length = validLength(heightsOrLength);
      this.#heights = new Float64Array(length);
      this.#sumTree = new Float64Array(length + 1);
      this.#knownTree = new Uint32Array(length + 1);
      this.#estimate = validHeight(estimate, 40);
      return;
    }

    this.#heights = new Float64Array(heightsOrLength.length);
    this.#sumTree = new Float64Array(heightsOrLength.length + 1);
    this.#knownTree = new Uint32Array(heightsOrLength.length + 1);
    this.#estimate = 40;
    for (let index = 0; index < heightsOrLength.length; index += 1) {
      const height = validHeight(heightsOrLength[index], 1);
      this.#heights[index] = height;
      this.#measuredTotal += height;
      this.#measuredCount += 1;
      this.#add(this.#sumTree, index, height);
      this.#add(this.#knownTree, index, 1);
    }
  }

  static uniform(length: number, estimate: number): BlockHeightIndex {
    return new BlockHeightIndex(length, estimate);
  }

  get length(): number {
    return this.#heights.length;
  }

  get estimate(): number {
    return this.#estimate;
  }

  get measuredAverage(): number | null {
    return this.#measuredCount === 0 ? null : this.#measuredTotal / this.#measuredCount;
  }

  get total(): number {
    return this.prefix(this.length);
  }

  setEstimate(height: number): void {
    if (Number.isFinite(height) && height > 0) this.#estimate = height;
  }

  update(index: number, height: number): void {
    if (!this.#contains(index) || !Number.isFinite(height) || height <= 0) return;
    const previous = this.#heights[index] ?? 0;
    if (Math.abs(previous - height) <= 1) return;
    this.#heights[index] = height;
    this.#measuredTotal += height - previous;
    this.#add(this.#sumTree, index, height - previous);
    if (previous === 0) {
      this.#measuredCount += 1;
      this.#add(this.#knownTree, index, 1);
    }
  }

  invalidate(index: number): void {
    if (!this.#contains(index)) return;
    const previous = this.#heights[index] ?? 0;
    if (previous === 0) return;
    this.#heights[index] = 0;
    this.#measuredTotal -= previous;
    this.#measuredCount -= 1;
    this.#add(this.#sumTree, index, -previous);
    this.#add(this.#knownTree, index, -1);
  }

  prefix(count: number): number {
    const bounded = Math.max(0, Math.min(this.length, Math.floor(count)));
    const measured = this.#query(this.#sumTree, bounded);
    const known = this.#query(this.#knownTree, bounded);
    return measured + (bounded - known) * this.#estimate;
  }

  span(start: number, end: number): number {
    const lower = Math.max(0, Math.min(this.length, Math.floor(start)));
    const upper = Math.max(lower, Math.min(this.length, Math.floor(end)));
    return this.prefix(upper) - this.prefix(lower);
  }

  atOffset(offset: number): number {
    if (this.length === 0) return -1;
    if (!Number.isFinite(offset)) return offset > 0 ? this.length - 1 : 0;
    const target = Math.max(0, offset);
    let lower = 0;
    let upper = this.length;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (this.prefix(middle + 1) <= target) lower = middle + 1;
      else upper = middle;
    }
    return Math.min(lower, this.length - 1);
  }

  #contains(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.length;
  }

  #query(tree: Float64Array | Uint32Array, count: number): number {
    let cursor = count;
    let total = 0;
    while (cursor > 0) {
      total += tree[cursor] ?? 0;
      cursor -= cursor & -cursor;
    }
    return total;
  }

  #add(tree: Float64Array | Uint32Array, index: number, delta: number): void {
    for (let cursor = index + 1; cursor < tree.length; cursor += cursor & -cursor) {
      tree[cursor] = (tree[cursor] ?? 0) + delta;
    }
  }
}

function validLength(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function validHeight(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
