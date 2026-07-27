import { expect, test } from "bun:test";
import type { Launched } from "@refrain/agent";
import { probeCommand } from "../src/main/probe";

const launched = (
  exited: Promise<number>,
  output = "",
  error = "",
): { run: Launched; wasKilled: () => boolean } => {
  let killed = false;
  return {
    run: {
      child: {} as never,
      exited,
      stdout: Promise.resolve(output),
      stderr: Promise.resolve(error),
      kill: () => {
        killed = true;
      },
    },
    wasKilled: () => killed,
  };
};

/**
 * Timeout and startup failure both used the number -1. The timeout branch came
 * first, so a command that could not start was reported as "timed out after
 * 4s" and the immediately following "cannot run" branch was unreachable.
 * These cases share every input except the kind of completion; their different
 * answers are the contract.
 */
test("a child failure is not reported as a timeout", async () => {
  const failed = launched(Promise.resolve(-1));

  expect(await probeCommand("broken", 50, () => failed.run)).toEqual({
    ok: false,
    detail: "cannot run broken",
  });
  expect(failed.wasKilled()).toBe(false);
});

test("a probe that does not return is killed and reported as a timeout", async () => {
  const waiting = launched(new Promise(() => undefined));

  expect(await probeCommand("sleeping", 1, () => waiting.run)).toEqual({
    ok: false,
    detail: "timed out after 1s",
  });
  expect(waiting.wasKilled()).toBe(true);
});

test("the first output line is the reported version", async () => {
  const ok = launched(Promise.resolve(0), "1.2.3\nmore\n");

  expect(await probeCommand("tool", 50, () => ok.run)).toEqual({ ok: true, detail: "1.2.3" });
});

test("a non-zero exit keeps the harness's first failure line", async () => {
  const failed = launched(Promise.resolve(3), "", "bad option\nusage follows\n");

  expect(await probeCommand("tool", 50, () => failed.run)).toEqual({
    ok: false,
    detail: "bad option",
  });
});
