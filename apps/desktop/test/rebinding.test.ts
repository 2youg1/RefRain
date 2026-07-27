import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withChord } from "../src/renderer/i18n.ts";
import { DEFAULT_BINDINGS } from "../src/renderer/keys.ts";
import { inspectChord, RESERVED } from "../src/renderer/reserved-keys.ts";

/**
 * Rebinding refuses what it cannot honour, and says what it collided with.
 *
 * `inspectChord` and the reserved table existed for a release with no caller,
 * so Settings wrote every chord straight through. Three ways that went wrong,
 * and the third is the one that cost the most: a chord already claimed by
 * another command was accepted, and then `commandFor` — which returns the
 * first entry whose keys match — kept running the older binding. The panel
 * showed the new assignment, the new assignment never fired, and nothing
 * anywhere said so.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const renderer = join(here, "..", "src", "renderer");
const read = (name: string): string => readFileSync(join(renderer, name), "utf8");
const shortcuts = read("Shortcuts.svelte");

test("a bare letter is refused", () => {
  // Under an IME every letter key is being typed constantly, and a candidate
  // window is often open on top of the manuscript.
  expect(inspectChord("J", "save", DEFAULT_BINDINGS)).toEqual({ kind: "bare-key" });
  expect(inspectChord("F", "review", DEFAULT_BINDINGS)).toEqual({ kind: "bare-key" });
});

test("a chord the system owns is refused, and says what owns it", () => {
  const problem = inspectChord("Ctrl+C", "review", DEFAULT_BINDINGS);
  expect(problem).toEqual({ kind: "reserved", meaning: "复制" });
});

test("a chord already in use is refused, and names the command holding it", () => {
  // Ctrl+R is review's by default; dispatch may not quietly take it.
  const problem = inspectChord("Ctrl+R", "dispatch", DEFAULT_BINDINGS);
  expect(problem).toEqual({ kind: "duplicate", otherCommand: "review" });

  // Naming the other side is the whole point: a refusal that only says "in
  // use" leaves the author hunting fifteen rows for the one to free up.
  expect((problem as { otherCommand: string }).otherCommand).toBe("review");
});

test("rebinding a command onto its own current chord is not a conflict", () => {
  expect(inspectChord("Ctrl+R", "review", DEFAULT_BINDINGS)).toBeUndefined();
});

test("a reserved chord is allowed for the command that means the same thing", () => {
  // Save must stay Ctrl+S. Inventing a different chord for it would be the
  // actual mistake, so reuse is correct where the meaning matches.
  expect(inspectChord("Ctrl+S", "save", DEFAULT_BINDINGS)).toBeUndefined();
  expect(inspectChord("Ctrl+O", "open", DEFAULT_BINDINGS)).toBeUndefined();
  // ...and refused for one that does not.
  expect(inspectChord("Ctrl+S", "review", DEFAULT_BINDINGS)).toMatchObject({ kind: "reserved" });
});

test("Escape remains reserved for cancellation", () => {
  // It is the one bare key RefRain accepts as a chord shape, but no writing
  // command may steal the cancellation reflex.
  expect(inspectChord("Esc", "zen", DEFAULT_BINDINGS)).toEqual({
    kind: "reserved",
    meaning: "取消",
  });
});

test("no default binding is itself refused", () => {
  // A default the validator would reject means the author cannot get back to
  // it after changing it once.
  for (const [id, chord] of Object.entries(DEFAULT_BINDINGS)) {
    expect({ id, problem: inspectChord(chord, id, DEFAULT_BINDINGS) }).toEqual({
      id,
      problem: undefined,
    });
  }
});

test("no two defaults share a chord", () => {
  const chords = Object.values(DEFAULT_BINDINGS).map((chord) => chord.toLowerCase());
  expect(new Set(chords).size).toBe(chords.length);
});

/** The defect was a caller that did not exist, so the wiring is asserted too. */
test("Settings runs every captured chord through the validator", () => {
  expect(shortcuts).toContain("inspectChord(chord, id, bindings)");
  expect(shortcuts).toContain("const message = refusal(chord, id)");
  expect(shortcuts).toContain("if (message !== null)");
  expect(RESERVED.length).toBeGreaterThan(0);
  // Refusal has to reach the screen, not just return early.
  expect(shortcuts).toContain('role="alert"');
  expect(shortcuts).toMatch(/refused/);
});

test("shortcut prose replaces its live binding rather than exposing a placeholder", () => {
  expect(withChord("Press {keys} now", "Alt+P")).toBe("Press Alt+P now");
  expect(withChord("No placeholder", undefined)).toBe("No placeholder");

  expect(read("Welcome.svelte")).toContain('withChord(t("welcome.hint"), paletteShortcut)');
  expect(read("Palette.svelte")).toContain('withChord(t("palette.hint"), shortcut)');
});

test("the context menu shows only chords that still exist", () => {
  const menu = read("ContextMenu.svelte");
  expect(menu).toContain("{bindings.dispatch}");
  expect(menu).not.toContain("Ctrl M");
  expect(menu).not.toContain("Ctrl D");
});
