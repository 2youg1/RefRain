/**
 * INV-8: the cost of saving follows the size of the change, not of the book.
 *
 * A 40,000-block manuscript threw `RangeError: Out of memory` on a single
 * save, whatever the author had changed — the alignment table is allocated
 * before anything is compared, so correcting one character cost exactly as
 * much as rewriting the whole book. At 20,000 blocks it did not crash; it took
 * five seconds, which for a keystroke-triggered save is its own kind of
 * failure.
 *
 * Six shapes, because the three cases in `diff-scale.test.ts` are all
 * replacements — the one mutation a same-length alignment handles best. A pure
 * insertion at the head is what breaks segmentation: every later line shifts
 * one position, nothing matches again, and no anchor is ever found.
 *
 * The budget is deliberately loose. This is a floor that catches the return of
 * an unbounded table, not a performance benchmark: CI machines are shared and
 * a tight threshold fails on Monday morning for reasons nobody can act on.
 *
 * Injection proof that this gate bites: raise `TABLE_BUDGET` in `align.ts`
 * past 10¹⁰, or make `align` skip `segment` and table the whole document, and
 * this exits 1 — out of memory at 40,000, or far past the budget at 20,000.
 */

import type { TextHead } from "../packages/core/src/domain.ts";
import { advanceTextHead } from "../packages/core/src/index.ts";

const head = (count: number): TextHead => ({
  id: "scale",
  blocks: Array.from({ length: count }, (_, i) => ({ id: `b${i}`, text: `第 ${i} 段的内容。` })),
  cause: "scale",
});

const SHAPES: ReadonlyArray<readonly [string, (lines: string[]) => string[]]> = [
  ["one word changed", (l) => l.map((t, i) => (i === 0 ? `${t}!` : t))],
  ["insert at the head", (l) => ["新的第一段。", ...l]],
  ["delete at the head", (l) => l.slice(1)],
  ["insert every tenth", (l) => l.flatMap((t, i) => (i % 10 === 0 ? ["插入。", t] : [t]))],
  ["rewrite everything", (l) => l.map((t) => `${t}改`)],
  ["reorder halves", (l) => [...l.slice(l.length / 2), ...l.slice(0, l.length / 2)]],
];

/** Blocks, and the wall time every shape at that size must stay under. */
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [20_000, 4_000],
  [40_000, 8_000],
  [100_000, 30_000],
];

const failures: string[] = [];

for (const [count, budgetMs] of SIZES) {
  for (const [name, mutate] of SHAPES) {
    const before = head(count);
    const text = mutate(before.blocks.map((b) => b.text)).join("\n\n");
    const started = performance.now();
    try {
      const advanced = advanceTextHead(before, text, "scale");
      const ms = performance.now() - started;
      if (ms > budgetMs)
        failures.push(
          `${count} blocks, ${name}: ${ms.toFixed(0)} ms, over the ${budgetMs} ms budget`,
        );
      if (advanced.head.blocks.length === 0)
        failures.push(`${count} blocks, ${name}: the advanced head came back empty`);
    } catch (error) {
      failures.push(
        `${count} blocks, ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("INV-8 violated: saving costs more than the change it records\n");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  `PASS  ${SIZES.length * SHAPES.length} shapes up to ${SIZES[SIZES.length - 1]?.[0]} blocks save inside their budget`,
);
