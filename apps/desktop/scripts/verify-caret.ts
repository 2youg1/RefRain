/**
 * The caret out-reads the text it sits in, in every theme.
 *
 * The caret used to borrow `--seal`. On six of the eight themes that left it
 * fainter against the paper than the ink was — 霞 measured |ΔL| 0.252 for the
 * caret against 0.630 for its own text — so the one mark the eye hunts for was
 * the faintest thing on the page. A one-pixel rule has no width to spare; the
 * only thing it can spend is contrast.
 *
 * `docs/theme-tokens.ts` asserts this while deriving, but that check only runs
 * when someone regenerates. This one reads the shipped stylesheet, so an
 * edited `themes.css` fails here even though nothing was regenerated.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, "src", "renderer", "themes.css"), "utf8");

/* Chromium hands back `oklch()` verbatim for a custom property rather than
 * resolving it to rgb, and reading L as if it were a red channel is how an
 * earlier gate reported nonsense. Parse the declared form. */
const lightnessOf = (declared: string | undefined): number => {
  const parsed = /oklch\(\s*([\d.]+)(%?)/.exec(declared ?? "");
  return parsed ? Number(parsed[1]) / (parsed[2] === "%" ? 100 : 1) : Number.NaN;
};

const tokenIn = (body: string, name: string): string | undefined =>
  new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(body)?.[1];

const themes = [...css.matchAll(/\[data-theme="([^"]+)"\][^{]*\{([\s\S]*?)\n\}/g)];

if (themes.length === 0) {
  console.error("FAIL  no themes found — the stylesheet moved or its shape changed");
  process.exit(1);
}

const failures: string[] = [];

for (const [, name, body] of themes) {
  const paper = lightnessOf(tokenIn(body ?? "", "paper"));
  const caret = lightnessOf(tokenIn(body ?? "", "caret"));
  const ink = lightnessOf(tokenIn(body ?? "", "ink"));

  if (Number.isNaN(paper) || Number.isNaN(caret) || Number.isNaN(ink)) {
    failures.push(`${name}: could not read paper, caret or ink`);
    continue;
  }

  const caretDelta = Math.abs(paper - caret);
  const inkDelta = Math.abs(paper - ink);
  console.log(
    `  ${(name ?? "").padEnd(9)} paper ${paper.toFixed(3)}  caret ${caret.toFixed(3)}  ` +
      `caret ΔL ${caretDelta.toFixed(3)}  ink ΔL ${inkDelta.toFixed(3)}`,
  );

  if (caretDelta <= inkDelta)
    failures.push(
      `${name}: caret ΔL ${caretDelta.toFixed(3)} does not beat ink ΔL ${inkDelta.toFixed(3)}`,
    );
}

/* The rule that binds the caret to the manuscript. A caret token nothing uses
 * would pass every check above while the page still drew the old colour. */
const appCss = readFileSync(join(root, "src", "renderer", "app.css"), "utf8");
if (!/caret-color:\s*var\(--caret\)/.test(appCss))
  failures.push("app.css does not set caret-color from --caret");

if (failures.length > 0) {
  console.error(`\nFAIL  ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`\nPASS  the caret out-reads the text in all ${themes.length} themes`);
