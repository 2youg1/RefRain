#!/usr/bin/env bun
/**
 * Run external commands as wide as the machine allows.
 *
 * **What it connects to.** Three callers spawn a list of independent processes
 * and read what each one wrote: `gate.ts` over the read-only stages,
 * `scriptc-build.ts` over eighteen compiles, and `verify:scriptc-coverage` over
 * thirty-seven coverage probes.
 *
 * **What it owns globally.** Two decisions those callers must not each make
 * again: how many processes may be in flight, and that results come back in
 * input order however the pool finished. Order is not cosmetic — a gate report
 * that changes shape between two runs of the same tree cannot be diffed, and
 * `gate.yml` lifts its check annotations out of that report by position.
 *
 * **What can be reused.** `run` for one command, `mapConcurrent` for a bounded
 * fan-out of anything.
 *
 * `spawnSync` cannot be used for this. It blocks the one JavaScript thread, so
 * a pool built on it runs exactly as slowly as a loop: measured, wrapping
 * `spawnSync` in a promise left `scriptc:build` at 62 s and the coverage gate
 * at 39 s, unchanged. The work is process startup, and only an asynchronous
 * spawn overlaps it.
 */

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

export interface CommandResult {
  /** Null when the process died on a signal rather than exiting. */
  readonly status: number | null;
  /** stdout and stderr, in the order the process produced them. */
  readonly output: string;
}

/** Run one command to completion, capturing everything it wrote. */
export function run(argv: readonly string[]): Promise<CommandResult> {
  const [command, ...args] = argv;
  if (command === undefined) return Promise.reject(new Error("a command needs a program"));
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

/**
 * Apply `work` to every item with a bounded number in flight.
 *
 * The returned array is in the order of `items`, not the order the pool
 * finished. The width is the machine's parallelism, never a written number: a
 * runner with two cores and a laptop with sixteen should not need different
 * source.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  let next = 0;
  const width = Math.max(1, Math.min(availableParallelism(), items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await work(item);
      }
    }),
  );
  return results;
}
