import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const renderer = join(here, "..", "src", "renderer");
const read = (name: string): string => readFileSync(join(renderer, name), "utf8");

/**
 * INV-6: every option the interface offers reaches a real implementation.
 *
 * The theme system is what taught us to write this down. Eight themes were
 * declared in `preferences.ts`, seven had selectors in `themes.css`, and the
 * settings panel offered three older identifiers that matched none of them —
 * so every click set `data-theme` to a value no stylesheet answered, and the
 * palette silently stayed put. Three sources of truth, no two agreeing, and a
 * green suite throughout: nothing compared the list on screen against the list
 * that renders.
 */

/** The single authority. Every other list is checked against this one. */
const declaredThemes = (): { id: string; mode: string }[] => {
  const source = read("preferences.ts");
  const block = source.slice(source.indexOf("export const THEMES"));
  return [
    ...block.slice(0, block.indexOf("];")).matchAll(/id: "([a-z]+)".*?mode: "(day|night)"/g),
  ].map((match) => ({ id: match[1] as string, mode: match[2] as string }));
};

test("every declared theme has a stylesheet that answers to it", () => {
  const css = read("themes.css");
  const missing = declaredThemes()
    .map((theme) => theme.id)
    .filter((id) => !css.includes(`[data-theme="${id}"]`));

  expect(missing).toEqual([]);
});

test("every declared theme has a label in both languages", () => {
  const i18n = read("i18n.ts");
  const missing = declaredThemes()
    .map((theme) => theme.id)
    .filter((id) => !i18n.includes(`"theme.${id}"`));

  expect(missing).toEqual([]);
});

test("the settings panel offers the declared themes and no others", () => {
  const settings = read("Settings.svelte");
  // Re-listing is how the panel came to offer three themes this file had never
  // heard of. It must iterate THEMES rather than spell identifiers out again.
  expect(settings).toContain("THEMES");

  const invented = [...settings.matchAll(/onTheme\("([a-z]+)"\)/g)].map((m) => m[1] as string);
  const declared = new Set(declaredThemes().map((theme) => theme.id));

  expect(invented.filter((id) => !declared.has(id))).toEqual([]);
});

test("the theme command cycles through declared themes only", () => {
  const app = read("App.svelte");
  const command = app.slice(app.indexOf('id: "theme"'));
  const cycled = [...command.slice(0, 400).matchAll(/theme === "([a-z]+)"/g)].map(
    (m) => m[1] as string,
  );
  const declared = new Set(declaredThemes().map((theme) => theme.id));

  expect(cycled.filter((id) => !declared.has(id))).toEqual([]);
});

test("day and night are both populated, because the toggle moves between them", () => {
  const themes = declaredThemes();

  // Not one palette and its inverse: a night theme is drawn from its own
  // reference, so the toggle needs somewhere to land on each side.
  expect(themes.filter((theme) => theme.mode === "day").length).toBeGreaterThan(0);
  expect(themes.filter((theme) => theme.mode === "night").length).toBeGreaterThan(0);
});

test("no orphaned translation keys survive from the retired three-theme set", () => {
  const i18n = read("i18n.ts");
  // `set.ai` / `set.kozo` / `set.ink` named rain, kōzo and night. Leaving them
  // in the dictionary is how a later reader concludes those themes still exist.
  for (const retired of ['"set.ai"', '"set.kozo"', '"set.ink"']) {
    expect(i18n).not.toContain(retired);
  }
});
