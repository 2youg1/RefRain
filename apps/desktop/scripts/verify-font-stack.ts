/**
 * One expression of the manuscript's font stack, not two.
 *
 * The stack was written out twice: once to render, once to measure the
 * baseline grid. The copies disagreed — the measuring one read
 * `"latin", "cjk", serif` and had no Japanese slot at all — so a manuscript
 * set in Japanese had its grid measured against a face the text was not
 * rendered in. `measureFontLine` returns a face's own ascent-plus-descent
 * ratio and Shippori Mincho does not agree with Chiron Sung HK about it, so
 * the rule was drawn through the middle of the characters: the exact defect
 * `measureFontLine` exists to prevent.
 *
 * A second copy cannot be caught by a test of either copy — each is correct
 * about itself. So this counts them. `manuscriptStack` is the authority; a
 * hand-assembled family list anywhere else is a second one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../src/renderer", import.meta.url));
const sources = readdirSync(RENDERER).filter(
  (name) => name.endsWith(".ts") || name.endsWith(".svelte"),
);

if (sources.length === 0) {
  console.error(
    "FAIL  found no renderer sources — this gate scans by directory and has gone blind",
  );
  process.exit(1);
}

/**
 * A copy names the Latin and Chinese slots together, building one value out of
 * them. Naming a slot alone is not the pattern — `Typography.svelte` names each
 * to draw its own chips, one family per button, which is a different question —
 * so the two must appear within a few lines of each other.
 */
const ASSEMBLES = /latinFamily[\s\S]{0,200}?cjkFamily/;

const AUTHORITY = "typography.ts";

const copies: string[] = [];
let authorityAssembles = false;

for (const name of sources) {
  const source = readFileSync(join(RENDERER, name), "utf8");
  if (!ASSEMBLES.test(source)) continue;
  if (name === AUTHORITY) {
    authorityAssembles = true;
    continue;
  }
  // A file may name both slots without building a stack: chips do exactly that.
  // What marks a second authority is doing it inside a family declaration.
  const near = source.match(ASSEMBLES)?.[0] ?? "";
  const context = source.slice(
    Math.max(0, source.indexOf(near) - 200),
    source.indexOf(near) + near.length + 200,
  );
  if (/font-family|--manuscript-family/.test(context)) copies.push(name);
}

if (!authorityAssembles) {
  console.error(
    `FAIL  ${AUTHORITY} no longer assembles the family stack — the authority this gate names has moved`,
  );
  process.exit(1);
}

if (copies.length > 0) {
  console.error(`FAIL  the manuscript font stack is expressed in ${copies.length + 1} place(s):`);
  for (const name of [AUTHORITY, ...copies]) console.error(`  ${name}`);
  console.error("      `manuscriptStack` in typography.ts is the authority; call it.");
  process.exit(1);
}

/*
 * The authority has to actually use all three slots, which is what was missing.
 *
 * Scanned from the arrow's body rather than from the declaration: the parameter
 * type names all three, so a body that dropped `jpFamily` still matched a text
 * search over the whole function and the assertion passed on the defect it was
 * written for. The type is a promise about the argument; the body is the fact.
 */
const authority = readFileSync(join(RENDERER, "typography.ts"), "utf8");
const declared = authority.indexOf("export const manuscriptStack");
if (declared === -1) {
  console.error("FAIL  manuscriptStack is gone from typography.ts");
  process.exit(1);
}
const body = authority.slice(authority.indexOf("=>", declared), declared + 900);

for (const slot of ["latinFamily", "jpFamily", "cjkFamily"]) {
  if (!body.includes(slot)) {
    console.error(`FAIL  manuscriptStack does not read the ${slot} slot`);
    console.error("      A stack missing a slot measures the grid against a face nobody reads in.");
    process.exit(1);
  }
}

console.log(
  `PASS  the manuscript font stack has one authority across ${sources.length} renderer sources`,
);
