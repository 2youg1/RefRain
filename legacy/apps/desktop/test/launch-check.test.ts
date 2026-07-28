import { expect, test } from "bun:test";
import { smokeCheckPassed } from "../scripts/launch-check.mjs";

test("one complete SMOKE_OK line plus a clean exit passes", () => {
  expect(smokeCheckPassed({ code: 0, signal: null, output: "booting\r\nSMOKE_OK\r\n" })).toBe(true);
});

test("printing SMOKE_OK before exit 1 cannot pass", () => {
  expect(smokeCheckPassed({ code: 1, signal: null, output: "SMOKE_OK\n" })).toBe(false);
});

test("a signal cannot pass even when the marker was printed", () => {
  expect(smokeCheckPassed({ code: null, signal: "SIGTERM", output: "SMOKE_OK\n" })).toBe(false);
});

test("SMOKE_OK embedded in another line is not the completion marker", () => {
  expect(smokeCheckPassed({ code: 0, signal: null, output: "prefix SMOKE_OK suffix\n" })).toBe(
    false,
  );
});
