import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * packages/core runs in two runtimes: `bun test` here, and Electron's Node in
 * the desktop app. A Bun-only import passes every test and then throws at
 * launch, which is exactly how `bun:sqlite` reached a release build.
 */
describe("core runs under Node as well as Bun", () => {
  test("no module imports a bun: builtin at the top level", async () => {
    const offenders: string[] = [];

    for await (const file of new Glob("packages/*/src/**/*.ts").scan(".")) {
      const text = await Bun.file(file).text();
      for (const [index, line] of text.split("\n").entries())
        if (/^\s*import\s[^;]*from\s+["']bun:/.test(line))
          offenders.push(`${file}:${index + 1}  ${line.trim()}`);
    }

    expect(offenders).toEqual([]);
  });
});
