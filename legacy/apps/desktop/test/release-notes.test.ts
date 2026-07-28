import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/release-notes.ts", import.meta.url));
const run = (tag: string) =>
  spawnSync(process.execPath, [script, tag], { encoding: "utf8", timeout: 5_000 });

test("release notes refuse a tag that does not match the desktop package", () => {
  const result = run("v0.1.5");

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("does not match apps/desktop/package.json version 0.1.6");
});

test("the current package tag resolves one substantial ROADMAP section", () => {
  const result = run("v0.1.6");

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("RefRain 0.1.6 is available");
  expect(result.stdout.length).toBeGreaterThan(200);
});
