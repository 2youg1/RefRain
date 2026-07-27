import { after, type Launched } from "./spawn.ts";

export type ProcessOutcome = {
  readonly reason: "exited" | "timed-out" | "cancelled";
  readonly code: number;
  readonly stdout: string;
};

type Ending = Exclude<ProcessOutcome["reason"], "exited">;

type ActiveProcess = {
  readonly child: Launched;
  ending?: Ending;
};

export interface ProcessLifecycle {
  start(runId: string, child: Launched, timeoutMs: number): void;
  complete(runId: string, finish: (outcome: ProcessOutcome) => void | Promise<void>): Promise<void>;
  cancel(runId: string): Promise<void>;
}

const TIMED_OUT: unique symbol = Symbol("timed-out");

/**
 * Owns the terminal race for every process-backed Run.
 *
 * Harness adapters still interpret exit codes and stdout, but none of them may
 * invent a second timeout, cancellation path, or completion Promise. The first
 * terminal cause wins; every waiter observes the same outcome and finalizer.
 */
export const processLifecycle = (): ProcessLifecycle => {
  const active = new Map<string, ActiveProcess>();
  const outcomes = new Map<string, Promise<ProcessOutcome>>();
  const completions = new Map<string, Promise<void>>();

  const wait = async (runId: string, process: ActiveProcess, timeoutMs: number) => {
    const timer = after(timeoutMs);
    try {
      const first = await Promise.race([process.child.exited, timer.promise.then(() => TIMED_OUT)]);

      let code: number;
      if (typeof first !== "number") {
        if (first !== TIMED_OUT) throw new Error("unknown process lifecycle outcome");
        if (process.ending === undefined) {
          process.ending = "timed-out";
          process.child.kill();
        }
        code = await process.child.exited;
      } else {
        code = first;
      }

      return {
        reason: process.ending ?? "exited",
        code,
        stdout: await process.child.stdout,
      } satisfies ProcessOutcome;
    } finally {
      timer.cancel();
      if (active.get(runId) === process) active.delete(runId);
    }
  };

  return {
    start(runId, child, timeoutMs) {
      if (outcomes.has(runId) || completions.has(runId))
        throw new Error(`process lifecycle already owns ${runId}`);
      const process: ActiveProcess = { child };
      active.set(runId, process);
      const outcome = wait(runId, process, timeoutMs);
      outcome.catch(() => undefined);
      outcomes.set(runId, outcome);
    },

    complete(runId, finish) {
      const existing = completions.get(runId);
      if (existing) return existing;

      const outcome = outcomes.get(runId);
      const completion = (
        outcome
          ? outcome.then(finish)
          : Promise.reject(new Error(`process lifecycle has not started ${runId}`))
      ).finally(() => outcomes.delete(runId));
      completion.catch(() => undefined);
      completions.set(runId, completion);
      return completion;
    },

    async cancel(runId) {
      const process = active.get(runId);
      if (process && process.ending === undefined) {
        process.ending = "cancelled";
        process.child.kill();
      }
      await outcomes.get(runId);
    },
  };
};
