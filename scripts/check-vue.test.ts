import { describe, expect, test } from "bun:test";
import { isKnownVueTscBootstrapFailure } from "./check-vue";

describe("Vue checker bootstrap classification", () => {
  test("accepts the local missing TypeScript entry point", () => {
    expect(isKnownVueTscBootstrapFailure("Cannot find module 'typescript/lib/tsc'")).toBe(true);
  });

  test("accepts the hosted-runner bootstrap frame on every path separator", () => {
    expect(
      isKnownVueTscBootstrapFailure(
        "/home/runner/node_modules/.bun/vue-tsc@3.3.8+hash/node_modules/vue-tsc/index.js:69",
      ),
    ).toBe(true);
    expect(
      isKnownVueTscBootstrapFailure(
        "D:\\a\\node_modules\\.bun\\vue-tsc@3.3.8+hash\\node_modules\\vue-tsc\\index.js:69",
      ),
    ).toBe(true);
  });

  test("rejects a source diagnostic", () => {
    expect(isKnownVueTscBootstrapFailure("src/App.vue(4,3): error TS2322")).toBe(false);
  });
});
