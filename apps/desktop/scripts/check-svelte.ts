#!/usr/bin/env bun
/**
 * Compile every Svelte component and fail on any warning that indicates a real
 * defect. Svelte's own compiler is the authority on its syntax.
 *
 * svelte-check would be the conventional choice, but 4.7.3 crashes under the
 * TypeScript 7 native compiler — it reaches for `useCaseSensitiveFileNames` on
 * an internal API that no longer exists. Recorded in SPEC 4.3.
 */

import { Glob } from "bun";
import { compile } from "svelte/compiler";

/** Cosmetic warnings that do not indicate a defect in a desktop application. */
const IGNORED = new Set(["a11y_no_noninteractive_element_to_interactive_role"]);

let failures = 0;
let scanned = 0;

for await (const file of new Glob("src/**/*.svelte").scan(".")) {
  scanned++;
  const source = await Bun.file(file).text();

  try {
    const { warnings } = compile(source, { filename: file, generate: "client" });
    for (const warning of warnings) {
      if (IGNORED.has(warning.code)) continue;
      console.error(`${file}:${warning.start?.line ?? 0}  ${warning.code}  ${warning.message}`);
      failures++;
    }
  } catch (error) {
    console.error(`${file}  ${error instanceof Error ? error.message : String(error)}`);
    failures++;
  }
}

// A guard that scans a literal path reports success when the path stops
// matching anything. Renaming src/ would have turned this into exit 0 forever.
if (scanned === 0) {
  console.error(
    "FAIL  src/**/*.svelte matched no components — this guard is not looking at anything",
  );
  process.exit(1);
}

if (failures > 0) {
  console.error(`\nFAIL  ${failures} Svelte issue${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`PASS  ${scanned} Svelte components compile cleanly`);
