import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packages = [
  "package.json",
  "apps/desktop/package.json",
  "packages/agent/package.json",
  "packages/core/package.json",
  "packages/fs/package.json",
  "e2e/ime/package.json",
  "e2e/ime/shells/e42/package.json",
  "e2e/ime/shells/e43/package.json",
  "e2e/ime/shells/e44/package.json",
] as const;
const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

test("every external JavaScript dependency is pinned to one exact version", () => {
  const loose: string[] = [];
  for (const path of packages) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (!version.startsWith("workspace:") && !exact.test(version))
        loose.push(`${path}: ${name}@${version}`);
    }
  }
  expect(loose).toEqual([]);
});

test("Bun and every isolated IME npm project carry a lockfile", () => {
  expect(existsSync(join(root, "bun.lock"))).toBe(true);
  for (const directory of [
    "e2e/ime",
    "e2e/ime/shells/e42",
    "e2e/ime/shells/e43",
    "e2e/ime/shells/e44",
  ])
    expect(existsSync(join(root, directory, "package-lock.json")), directory).toBe(true);
});

test("the Bun lock names the current project and the IME setup consumes locks", () => {
  const lock = readFileSync(join(root, "bun.lock"), "utf8");
  expect(lock).toMatch(/""\s*:\s*\{\s*"name"\s*:\s*"refrain"/);
  expect(lock).not.toContain('"name": "recension"');

  const prepare = readFileSync(join(root, "e2e/ime/scripts/prepare.ps1"), "utf8");
  expect(prepare.match(/npm ci --no-audit --no-fund/g)).toHaveLength(2);
  expect(prepare).not.toMatch(/npm install/);
});
