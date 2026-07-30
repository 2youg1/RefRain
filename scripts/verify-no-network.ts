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
 * any component or Rust crate and this exits 1 naming the file and line.
 *
 * Shiki is the one dependency that can break this promise without writing a
 * single `fetch`. Its convenience entry (`import { codeToHtml } from "shiki"`)
 * loads languages and themes on demand: the bundler emits a dynamic chunk and,
 * worst case, the grammar is fetched from a CDN. The precise entry
 * (`shiki/core` plus one static import per language) resolves everything at
 * build time. That difference is invisible in the rendered output and shows up
 * only as a request in production, so it is asserted here rather than trusted.
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

// Shiki must be reached through the precise entry only.
const SHIKI_SOURCES = ["apps/desktop/src/**/*.{ts,tsx}", "packages/**/src/**/*.ts"];
const convenience = await scan(SHIKI_SOURCES, /from\s+["']shiki["']/, {
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line),
});
if (convenience.findings.length > 0) {
  console.error(
    "FAIL  verify:no-network: the shiki convenience entry can fetch grammars at runtime",
  );
  for (const finding of convenience.findings) {
    console.error(
      `      ${finding.file}:${finding.line}  use \`shiki/core\` with one static import per language`,
    );
  }
  process.exit(1);
}

// And every language must arrive as a static import, never `await import(...)`.
const lazyLang = await scan(SHIKI_SOURCES, /import\s*\(\s*["']@shikijs\//, {
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line),
});
if (lazyLang.findings.length > 0) {
  console.error("FAIL  verify:no-network: a shiki language is imported dynamically");
  for (const finding of lazyLang.findings) {
    console.error(`      ${finding.file}:${finding.line}  make it a top-level static import`);
  }
  process.exit(1);
}

report("verify:no-network", result, "an outbound request appears in the application process");
