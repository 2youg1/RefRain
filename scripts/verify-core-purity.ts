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

const result = await scan(["crates/refrain-core/src/**/*.rs"], FORBIDDEN, {
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line),
});

report(
  "verify:core-purity",
  result,
  "refrain-core reaches a dependency the domain must not know about",
);
