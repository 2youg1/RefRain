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

report(
  "verify:trash-only",
  { scanned: result.scanned, findings: production },
  "a permanent delete exists outside the trash path",
);
