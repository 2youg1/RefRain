import { expect, test } from "bun:test";
import { terminateAfterCleanup } from "../scripts/verification-teardown.ts";

test("verification exits with failure even when teardown throws", () => {
  const exits: number[] = [];
  const errors: string[] = [];

  expect(() =>
    terminateAfterCleanup(
      0,
      () => {
        throw new Error("fixture is busy");
      },
      (code) => exits.push(code),
      (message) => errors.push(message),
    ),
  ).not.toThrow();
  expect(exits).toEqual([1]);
  expect(errors).toEqual(["cleanup failed: Error: fixture is busy"]);
});

test("verification preserves its result when teardown succeeds", () => {
  const exits: number[] = [];

  terminateAfterCleanup(
    2,
    () => {},
    (code) => exits.push(code),
  );

  expect(exits).toEqual([2]);
});
