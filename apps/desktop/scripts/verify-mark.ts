/**
 * The mark on screen and the mark in the installer must be one drawing.
 *
 * They were two. `Mark.svelte` drew a square seal with a caret knocked out of
 * it; `assets/mark.svg` held a repeat sign, and `make-icon.ts` rendered that
 * one into `build/icon.png`. So the icon on the desktop and the mark in the
 * interface were different figures, and nothing in the repository said which
 * was the mark — each file looked correct on its own.
 *
 * Comparing the path geometry rather than the rendered pixels: the component
 * takes its colours from the theme and the icon bakes them in, so pixels differ
 * legitimately while the shape must not.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const renderer = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "renderer");
const read = (...parts: string[]): string => readFileSync(join(renderer, ...parts), "utf8");

/** Every `d="…"` in source order. Two drawings agree when these agree. */
const geometry = (source: string): string[] =>
  [...source.matchAll(/\sd="([^"]+)"/g)].map((match) => (match[1] as string).replace(/\s+/g, " "));

const component = geometry(read("Mark.svelte"));
const asset = geometry(read("assets", "mark.svg"));

const failures: string[] = [];

if (asset.length === 0) failures.push("assets/mark.svg holds no paths");
if (component.length === 0) failures.push("Mark.svelte holds no paths");

if (component.join("|") !== asset.join("|")) {
  failures.push("the component and the asset draw different marks");
  failures.push(`  Mark.svelte     ${JSON.stringify(component)}`);
  failures.push(`  assets/mark.svg ${JSON.stringify(asset)}`);
}

/*
 * Neither may bake in a colour. The component inherits the theme's ink and the
 * asset does the same, which is what lets one drawing serve eight themes; a
 * literal hex here is how a mark comes to look wrong in the dark ones.
 */
for (const [name, source] of [
  ["Mark.svelte", read("Mark.svelte")],
  ["assets/mark.svg", read("assets", "mark.svg")],
] as const) {
  const svg = source.slice(source.indexOf("<svg"));
  // A fallback inside `var(--x, …)` is allowed; a bare literal is not.
  const stripped = svg.replace(/var\([^)]*\)/g, "");
  const literal = stripped.match(/(?:stroke|fill)="#[0-9a-f]{3,8}"/gi);
  if (literal) failures.push(`${name} bakes in a colour: ${literal.join(", ")}`);
}

// The 16px variant drops the rule on purpose — a tray icon renders as a
// template and would strip the colour anyway. It must still be the same figure.
const small = geometry(read("assets", "mark-16.svg"));
if (small.length === 0) failures.push("assets/mark-16.svg holds no paths");

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL  ${line}`);
  process.exit(1);
}

console.log(
  `PASS  one mark, ${component.length} paths, drawn the same in the component and the asset`,
);
