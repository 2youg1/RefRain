import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

test("the canonical desktop build has no Unix-shell dependency", () => {
  const root = json<{ scripts: Record<string, string> }>("package.json");
  const desktop = json<{ scripts: Record<string, string> }>("apps/desktop/package.json");
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  expect(root.scripts["build:desktop"]).toBe("bun apps/desktop/scripts/build-desktop.ts");
  expect(desktop.scripts.build).toBe("bun scripts/build-desktop.ts");
  expect(release).toContain("run: bun scripts/build-desktop.ts");
  expect(release).not.toContain("run: ./make.sh");
});
