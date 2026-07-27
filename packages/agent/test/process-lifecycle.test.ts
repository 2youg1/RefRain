import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { type ProcessOutcome, processLifecycle } from "../src/process-lifecycle.ts";
import type { Launched } from "../src/spawn.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const controlledChild = (onKill?: () => void) => {
  const exit = deferred<number>();
  const stdout = deferred<string>();
  let kills = 0;
  const launched: Launched = {
    child: {} as ChildProcess,
    exited: exit.promise,
    stdout: stdout.promise,
    stderr: Promise.resolve(""),
    kill: () => {
      kills += 1;
      onKill?.();
    },
  };
  return { launched, exit, stdout, kills: () => kills };
};

test("completion before process start fails instead of posing as finished", async () => {
  const lifecycle = processLifecycle();
  const completion = lifecycle.complete("run1", () => undefined);

  await expect(completion).rejects.toThrow(/has not started run1/);
  expect(() => lifecycle.start("run1", controlledChild().launched, 1_000)).toThrow(
    /already owns run1/,
  );
});

test("one run has one completion even when several callers wait", async () => {
  const child = controlledChild();
  const lifecycle = processLifecycle();
  let finishes = 0;
  lifecycle.start("run1", child.launched, 1_000);

  const first = lifecycle.complete("run1", (outcome) => {
    finishes += 1;
    expect(outcome).toEqual({ reason: "exited", code: 0, stdout: "report" });
  });
  const second = lifecycle.complete("run1", () => {
    finishes += 100;
  });

  expect(second).toBe(first);
  child.stdout.resolve("report");
  child.exit.resolve(0);
  await first;

  expect(finishes).toBe(1);
  expect(lifecycle.complete("run1", () => undefined)).toBe(first);
});

test("a finalizer failure is the one rejection every caller replays", async () => {
  const child = controlledChild();
  const lifecycle = processLifecycle();
  const failure = new Error("adapter interpretation failed");
  lifecycle.start("run1", child.launched, 1_000);

  const first = lifecycle.complete("run1", () => {
    throw failure;
  });
  const second = lifecycle.complete("run1", () => undefined);
  child.stdout.resolve("");
  child.exit.resolve(3);

  expect(second).toBe(first);
  expect(await first.catch((error) => error)).toBe(failure);
  expect(await second.catch((error) => error)).toBe(failure);
});

test("cancellation kills once and resolves only after the process exits", async () => {
  const child = controlledChild();
  const lifecycle = processLifecycle();
  let outcome: ProcessOutcome | undefined;
  let cancelled = false;
  lifecycle.start("run1", child.launched, 1_000);
  const completion = lifecycle.complete("run1", (result) => {
    outcome = result;
  });

  const cancellation = lifecycle.cancel("run1").then(() => {
    cancelled = true;
  });
  await Bun.sleep(5);

  expect(child.kills()).toBe(1);
  expect(cancelled).toBe(false);

  child.stdout.resolve("partial");
  child.exit.resolve(-1);
  await cancellation;
  await completion;

  expect(outcome).toEqual({ reason: "cancelled", code: -1, stdout: "partial" });
  await lifecycle.cancel("run1");
  expect(child.kills()).toBe(1);
});

test("timeout owns the terminal reason and waits for the killed process", async () => {
  let child!: ReturnType<typeof controlledChild>;
  child = controlledChild(() => {
    child.stdout.resolve("late output");
    child.exit.resolve(-1);
  });
  const lifecycle = processLifecycle();
  let outcome: ProcessOutcome | undefined;
  lifecycle.start("run1", child.launched, 10);

  await lifecycle.complete("run1", (result) => {
    outcome = result;
  });

  expect(child.kills()).toBe(1);
  expect(outcome).toEqual({ reason: "timed-out", code: -1, stdout: "late output" });
});

test("both process adapters delegate the terminal race to one authority", () => {
  for (const name of ["command.ts", "claude-code.ts"]) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    expect(source).toContain("processLifecycle()");
    expect(source).not.toMatch(/Promise\.race|TIMED_OUT|Map<string, Launched>/);
  }
});
