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
 *
 * What this gate forbids is the *dynamic import*, not lazy loading. Measured:
 * `await import(`@shikijs/langs/${name}`)` survives bundling verbatim and the
 * grammar bytes never enter the output — the bundler cannot resolve a template
 * literal, so it gives up rather than inlining. Loading a grammar at runtime is
 * then a fetch by another name.
 *
 * Deferring the *work* is fine and needs no dynamic import: import every
 * grammar statically into a registry, start the highlighter with `langs: []`,
 * and call `loadLanguage(registry[name])` when a fence of that language first
 * appears. Measured at 1.4–2.6 ms per grammar, against 53 ms to compile all
 * thirty up front. The bytes still ship in the bundle — that is the point — but
 * the regexes are only built for languages the author actually wrote.
 */

import { report, scan } from "./gate-lib.ts";

const OUTBOUND =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(|\breqwest::|\bureq::|\bhyper::Client|https?:\/\/(?!localhost|127\.0\.0\.1|schema\.tauri\.app|biomejs\.dev)/;

const result = scan(
  [
    "apps/desktop/src/**/*.{ts,tsx}",
    "apps/desktop/src-tauri/src/**/*.rs",
    "crates/**/src/**/*.rs",
    "packages/**/src/**/*.ts",
  ],
  OUTBOUND,
  {
    // A comment explaining the rule is not a violation of it. A URL inside a
    // doc comment is how the reason gets recorded.
    //
    // `refrain-artifact://` 也不是违反：它是本进程自己注册的 custom protocol，
    // 请求由 Rust 在同一进程里应答，一个字节都不出机器（F-10 / D5）。这条
    // 承诺管的是出网，不是管 `fetch` 这个词。
    //
    // 放行的是**整行恰好只有这一个 fetch**，不是「这行里出现过它」：早先写成
    // 后者时，`fetch("https://evil.example.com") || fetch(`refrain-artifact://…`)`
    // 整行被一起放过，注入验红当场不咬人。白名单要窄到一个真实的攻击写法
    // 无法藏在它后面。
    ignoreLine: (line) =>
      /^\s*(\/\/|\/\*|\*|#)/.test(line) ||
      /^\s*(?:const\s+\w+\s*=\s*)?await\s+fetch\(\s*`refrain-artifact:\/\/[^`]*`\s*\);?\s*$/.test(
        line,
      ),
  },
);

// Shiki must be reached through the precise entry only.
const SHIKI_SOURCES = ["apps/desktop/src/**/*.{ts,tsx}", "packages/**/src/**/*.ts"];
const convenience = scan(SHIKI_SOURCES, /from\s+["']shiki["']/, {
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
const lazyLang = scan(SHIKI_SOURCES, /import\s*\(\s*["']@shikijs\//, {
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
