#!/usr/bin/env bun
/**
 * SPEC 6.2: refrain-core is pure domain.
 *
 * No tauri, no rusqlite, no filesystem writes, no processes. The boundary is
 * what lets the domain be tested without a window and reasoned about without a
 * database — and it erodes one convenient import at a time.
 *
 * Injection proof that this gate bites: add `use std::fs;` to any core module
 * and this exits 1 naming the file and line.
 */

import { report, scan } from "./gate-lib.ts";

const FORBIDDEN =
  /^\s*use\s+(tauri|rusqlite|std::fs|std::process|std::net|std::path::PathBuf)\b|\bstd::fs::(write|create|remove|rename|copy|File::create)\b/;

const result = scan(["crates/refrain-core/src/**/*.rs"], FORBIDDEN, {
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line),
});

// refrain-app holds the multi-step flows, so it may reach the store and the
// filesystem — but not Tauri. That is the whole reason it exists: collecting a
// dispatch was a 182-line command body that no test could reach without a
// window. Its Cargo.toml says "Nothing here knows about Tauri"; this is the
// sentence's gate.
//
// Injection proof: add `use tauri::State;` to any module under
// crates/refrain-app/src and this exits 1 naming the file and line.
const appResult = scan(["crates/refrain-app/src/**/*.rs"], /^\s*use\s+tauri\b/, {
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line),
});

report(
  "verify:core-purity",
  {
    scanned: result.scanned + appResult.scanned,
    findings: [...result.findings, ...appResult.findings],
  },
  "a crate reaches a dependency its layer must not know about",
);
