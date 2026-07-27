import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/renderer/App.svelte", import.meta.url), "utf8");

test("project-scoped work follows the active chapter's Root", () => {
  expect(app).toContain("activeChapter?.root ?? roots[0] ?? null");
  expect(app).not.toContain("const root = $derived(roots[0] ?? null)");
});
