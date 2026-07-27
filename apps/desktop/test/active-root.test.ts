import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/renderer/App.svelte", import.meta.url), "utf8");

test("project-scoped work follows the active chapter's Root", () => {
  expect(app).toContain("activeChapter?.root ?? roots[0] ?? null");
  expect(app).not.toContain("const root = $derived(roots[0] ?? null)");
});

test("the file browser cache belongs to one Root", () => {
  expect(app).toContain("let fileOwner = $state<string | null>(null)");
  expect(app).toContain("if (fileOwner !== owner)");
  expect(app).toContain("{#key fileOwner}");

  /*
   * The cache is dropped before the early return, not after it.
   *
   * Reversing them serves the previous Root's entries under the new one's
   * name — the browser shows another folder's files and the author has no way
   * to tell. This asserted the two lines verbatim, in one spelling of the
   * early return, so rewriting that condition to an equivalent one broke the
   * test without touching the rule. It now checks the order of the two facts.
   */
  const body = app.slice(app.indexOf("const openFiles ="));
  const claims = body.indexOf("claimFileView(owner)");
  const returnsEarly = body.search(/if \([^)]*fileTotal > 0[^)]*\) return/);
  expect(claims).toBeGreaterThan(-1);
  expect(returnsEarly).toBeGreaterThan(-1);
  expect(claims).toBeLessThan(returnsEarly);
});
