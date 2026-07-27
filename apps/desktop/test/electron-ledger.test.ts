import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const build = readFileSync(new URL("../make.sh", import.meta.url), "utf8");

test("the ledger check runs under Electron's embedded Node", () => {
  expect(build).toContain("ELECTRON_RUN_AS_NODE=1 bun x electron");
  expect(build).not.toMatch(/^node dist\/checks\/node-ledger-check\.cjs$/m);
});
