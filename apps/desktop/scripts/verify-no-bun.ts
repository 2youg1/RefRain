/**
 * The packaged main process must not name a Bun global.
 *
 * This guard exists because of a shipped defect, not a hypothetical one:
 * `make.sh` bundles the main process with `--target=node`, Electron's main
 * process is Node, and `Bun` does not exist there. Seven `Bun.spawn` and
 * `Bun.sleep` calls survived into the release. Every test passed — `bun test`
 * runs under Bun — while the shipped application answered every agent probe
 * with `Bun is not defined`, returned an empty font list, and could not
 * dispatch to any harness. The runtime that runs the tests is not the runtime
 * that ships.
 *
 * The check reads the built bundle rather than the sources, because that is
 * the artefact a user runs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const bundles = ["dist/main/main.cjs", "dist/main/preload.cjs"];

// `Bun.` as a member access. A comment mentioning the word is not a call, so
// the pattern requires the dot and an identifier after it.
const CALL = /\bBun\s*\.\s*[A-Za-z_$]/g;

let failed = false;
let checked = 0;

for (const relative of bundles) {
  const path = join(root, relative);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    console.error(`MISSING ${relative} — run ./make.sh first`);
    failed = true;
    continue;
  }

  checked += 1;
  const hits = [...source.matchAll(CALL)];
  if (hits.length === 0) continue;

  failed = true;
  console.error(`${relative}: ${hits.length} Bun.* reference(s) in a --target=node bundle`);
  for (const hit of hits.slice(0, 8)) {
    const line = source.slice(0, hit.index).split("\n").length;
    console.error(`  line ${line}: ${source.slice(hit.index, hit.index + 40).split("\n")[0]}`);
  }
}

// A guard that scans nothing passes silently. Asserting the file count is what
// keeps a renamed output path from turning this into a permanent exit 0.
if (checked !== bundles.length) {
  console.error(`checked ${checked} of ${bundles.length} bundles — the guard did not run`);
  failed = true;
}

if (failed) process.exit(1);
console.log(`PASS  ${checked} main-process bundles carry no Bun.* reference`);
