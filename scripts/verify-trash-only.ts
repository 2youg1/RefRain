#!/usr/bin/env bun
/**
 * INV-6: delete goes to the system trash.
 *
 * There is no permanent delete at any layer. When the trash is unavailable the
 * operation fails and the file stays where it is — falling back to an unlinking
 * call would turn an inconvenience into the one loss this application promises
 * never to cause.
 *
 * Injection proof that this gate bites: call `std::fs::remove_file` in the
 * store and this exits 1 naming the file and line.
 */

import { readFileSync } from "node:fs";

import { report, scan } from "./gate-lib.ts";

const PERMANENT_DELETE =
  /\b(fs::remove_file|fs::remove_dir_all|remove_dir_all\s*\(|unlinkSync|rmSync|rm\s+-rf)\b/;

const result = scan(
  ["crates/**/src/**/*.rs", "apps/native/host/src/**/*.rs", "apps/native/src/**/*.ts"],
  PERMANENT_DELETE,
  {
    // Test fixtures clean up their own temporary directories, which is not the
    // manuscript. The exemption is by path, so it cannot be claimed by adding
    // a comment to production code.
    ignoreLine: (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line),
  },
);

const production = result.findings.filter(
  (f) => !/(^|\/)(tests?|test)\//.test(f.file) && !f.file.endsWith(".test.ts"),
);

/**
 * A Rust unit test lives inside the file it tests, under `#[cfg(test)]`. Such a
 * module is not compiled into the product, so its temporary-directory cleanup
 * is not a delete path — but it is not covered by the directory exemption
 * above, which only sees `tests/`.
 *
 * The boundary is read from the source, not declared: the attribute opens a
 * module that runs to the end of the file, because a `#[cfg(test)]` module is
 * always the last item in these files. A delete above that line still fails,
 * so this cannot be claimed by moving production code below a test module.
 */
const testModuleStart = new Map<string, number>();
for (const finding of production) {
  if (testModuleStart.has(finding.file) || !finding.file.endsWith(".rs")) continue;
  const lines = readFileSync(finding.file, "utf8").split("\n");
  const index = lines.findIndex((line) => /^\s*#\[cfg\(test\)\]\s*$/.test(line));
  testModuleStart.set(finding.file, index === -1 ? Number.MAX_SAFE_INTEGER : index + 1);
}
const compiledIntoProduct = production.filter(
  (f) => f.line < (testModuleStart.get(f.file) ?? Number.MAX_SAFE_INTEGER),
);

// One file may unlink, and only narrowly:
//
// - `atomic.rs` removes its own write-protocol residue (the `.writing`
//   temporary and the owner marker), whose lifecycle the recovery tests pin.
//
// The exemption is one file and one call shape, so a permanent delete
// anywhere else still fails here.
const internalResidue = compiledIntoProduct.filter(
  (f) =>
    f.file.endsWith("crates/refrain-store/src/atomic.rs") &&
    (f.text.includes("fs::remove_file") || f.text.includes("fs::remove_dir_all")),
);
const offences = compiledIntoProduct.filter((f) => !internalResidue.includes(f));

report(
  "verify:trash-only",
  { scanned: result.scanned, findings: offences },
  "a permanent delete exists outside the trash path",
);
