#!/usr/bin/env bun
/**
 * SPEC 5: outside Rust, everything is TypeScript.
 *
 * A hand-written `.js` file escapes the type checker and the strictness that
 * comes with it. Generated output and configuration files that only exist in
 * JavaScript form are the exceptions, and they are named rather than inferred.
 *
 * Injection proof that this gate bites: add `apps/desktop/src/helper.js` and
 * this exits 1 naming it.
 */

import { collect } from "./gate-lib.ts";

const ALLOWED = /(^|\/)(vite|biome|tauri)\.config\.js$|(^|\/)src\/generated\//;

const files = await collect([
  "apps/**/*.{js,jsx,cjs,mjs}",
  "crates/**/*.{js,jsx,cjs,mjs}",
  "packages/**/*.{js,jsx,cjs,mjs}",
  "scripts/**/*.{js,jsx,cjs,mjs}",
  "e2e/**/*.{js,jsx,cjs,mjs}",
]);

const offences = files.filter((file) => !ALLOWED.test(file));

if (offences.length > 0) {
  console.error("FAIL  verify:no-js: a hand-written JavaScript file is in the repository");
  for (const file of offences) console.error(`      ${file}`);
  process.exit(1);
}

/*
 * No empty-scan check here, and the reason matters: this gate asserts an
 * absence, so zero files found is the passing state, not a broken scanner. The
 * scanner is instead proved by `verify:gates-run`, which requires every gate to
 * be reachable, and by the injection record — a `.js` file added under any of
 * the globs above does turn this red.
 */
console.log(
  `PASS  verify:no-js  (${files.length} JavaScript file(s) found, all in the allowed set)`,
);
