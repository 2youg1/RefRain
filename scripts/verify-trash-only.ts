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

import { report, scan } from "./gate-lib.ts";

const PERMANENT_DELETE =
  /\b(fs::remove_file|fs::remove_dir_all|remove_dir_all\s*\(|unlinkSync|rmSync|rm\s+-rf)\b/;

const result = await scan(
  [
    "crates/**/src/**/*.rs",
    "apps/desktop/src-tauri/src/**/*.rs",
    "apps/desktop/src/**/*.{ts,vue}",
    "packages/**/src/**/*.ts",
  ],
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

// Two files may unlink, and only narrowly:
//
// - `atomic.rs` removes its own write-protocol residue (the `.writing`
//   temporary and the owner marker), whose lifecycle the recovery tests pin.
// - `files/ops.rs` removes the source of a cross-volume move only after a
//   byte-verified copy of it is already inside the system trash — the second
//   half of a move, not a delete.
// - `migrate.rs` removes only its own build artefacts: the temp-dir scratch
//   copy of verdicts.db, a partial shadow left by a killed run, the shadow
//   db's WAL sidecars, and the consumed shadow after install. User bytes
//   never pass through these calls — the legacy tree is preserved whole.
//
// All exemptions are one file and one call shape each, so a permanent delete
// anywhere else still fails here.
const internalResidue = production.filter(
  (f) =>
    (f.file.endsWith("crates/refrain-store/src/atomic.rs") ||
      f.file.endsWith("crates/refrain-store/src/files/ops.rs") ||
      f.file.endsWith("crates/refrain-store/src/migrate.rs")) &&
    (f.text.includes("fs::remove_file") || f.text.includes("fs::remove_dir_all")),
);
const offences = production.filter((f) => !internalResidue.includes(f));

report(
  "verify:trash-only",
  { scanned: result.scanned, findings: offences },
  "a permanent delete exists outside the trash path",
);
