import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The build moved from `make.sh` into Bun so the same command runs on Windows
 * without Git Bash, and this assertion stayed pointed at the shell script —
 * which is now three lines that exec the real one. It kept passing on the
 * `electron` the old text still contained, then failed once that text was
 * reduced to a forwarding line. Read the file that performs the step.
 */
const build = readFileSync(new URL("../scripts/build-desktop.ts", import.meta.url), "utf8");

test("the ledger check runs under Electron's embedded Node", () => {
  // `core` targets two runtimes and `bun test` only ever proves the Bun one. A
  // system `node` is not the answer either: Electron's embedded Node can lack
  // a `node:sqlite` a system Node has, and that difference is exactly what
  // this probe exists to catch before a release carries it.
  expect(build).toContain("ELECTRON_RUN_AS_NODE");
  expect(build).toContain("dist/checks/node-ledger-check.cjs");
  expect(build).not.toMatch(/\bnode dist\/checks\/node-ledger-check\.cjs\b/);
});
