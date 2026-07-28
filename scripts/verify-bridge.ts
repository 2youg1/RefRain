#!/usr/bin/env bun
/**
 * INV-11: only generated bindings cross the bridge.
 *
 * A hand-written `invoke("some_command", …)` bypasses the generated types, so
 * a renamed command or a changed payload shape fails at runtime instead of at
 * compile time. `__TAURI__` reaches the raw global for the same effect.
 *
 * Injection proof that this gate bites: write `invoke("health", {})` in any
 * component and this exits 1 naming the file and line.
 */

import { report, scan } from "./gate-lib.ts";

const HAND_WRITTEN = /\binvoke\s*\(|\b__TAURI__\b|@tauri-apps\/api\/core/;

const result = await scan(
  ["apps/desktop/src/**/*.{ts,vue}", "packages/**/src/**/*.ts"],
  HAND_WRITTEN,
  {
    ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line),
  },
);

// `src/generated/` is where the generated bindings legitimately call invoke.
const outside = result.findings.filter((f) => !f.file.includes("src/generated/"));

report(
  "verify:bridge",
  { scanned: result.scanned, findings: outside },
  "a hand-written bridge call appears outside src/generated/",
);
