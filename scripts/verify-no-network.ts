#!/usr/bin/env bun
/**
 * INV-1: the application process makes no outbound request.
 *
 * No model call, no API key, no telemetry, no auto-update. A model runs inside
 * the author's own harness, launched as a child process — that process may
 * reach the network, and saying otherwise would be the dishonest version of
 * this promise (SPEC 5.1).
 *
 * Injection proof that this gate bites: add `fetch("https://example.com")` to
 * any Vue component or Rust crate and this exits 1 naming the file and line.
 */

import { report, scan } from "./gate-lib.ts";

const OUTBOUND =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(|\breqwest::|\bureq::|\bhyper::Client|https?:\/\/(?!localhost|127\.0\.0\.1|schema\.tauri\.app|biomejs\.dev)/;

const result = await scan(
  [
    "apps/desktop/src/**/*.{ts,vue}",
    "apps/desktop/src-tauri/src/**/*.rs",
    "crates/**/src/**/*.rs",
    "packages/**/src/**/*.ts",
  ],
  OUTBOUND,
  {
    // A comment explaining the rule is not a violation of it. A URL inside a
    // doc comment is how the reason gets recorded.
    ignoreLine: (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line),
  },
);

report("verify:no-network", result, "an outbound request appears in the application process");
