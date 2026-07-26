#!/usr/bin/env bun
// SPEC 1.3: the app process makes no outbound network requests. A stray import
// survives code review easily, so the rule is enforced mechanically.
//
// Every layer that runs inside the application is scanned, not just `core`.
// An earlier version checked `core` alone while CI announced it as covering
// the whole process — the agent layer launches harnesses and the main process
// owns the window, and either could have reached the network unnoticed.

import { Glob } from "bun";

const banned = [
  { pattern: /\bfetch\s*\(/, what: "fetch()" },
  { pattern: /\bXMLHttpRequest\b/, what: "XMLHttpRequest" },
  { pattern: /\bWebSocket\b/, what: "WebSocket" },
  { pattern: /\bEventSource\b/, what: "EventSource" },
  { pattern: /from\s+["']node:(https?|net|dgram|dns|tls)["']/, what: "node network module" },
  {
    pattern: /require\(\s*["']node:(https?|net|dgram|dns|tls)["']\s*\)/,
    what: "node network module",
  },
  // Electron's own client, which bypasses every check above.
  { pattern: /\bnet\.request\s*\(/, what: "Electron net.request()" },
  { pattern: /\bautoUpdater\b/, what: "autoUpdater" },
];

/**
 * The surfaces that run inside the application process.
 *
 * The renderer is included: it holds no privilege, but a stray `fetch` there
 * would still be an outbound request from this application. Scripts under
 * `scripts/` are excluded — they are development tooling, and the rendering
 * checks legitimately serve a bundle over loopback.
 */
const surfaces = [
  "packages/core/src/**/*.ts",
  "packages/agent/src/**/*.ts",
  "packages/fs/src/**/*.ts",
  "apps/desktop/src/**/*.ts",
  "apps/desktop/src/**/*.svelte",
];

const violations: string[] = [];
let scanned = 0;

for (const surface of surfaces) {
  for await (const file of new Glob(surface).scan(".")) {
    scanned += 1;
    const text = await Bun.file(file).text();
    text.split("\n").forEach((line, index) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      for (const { pattern, what } of banned) {
        if (pattern.test(line)) violations.push(`${file}:${index + 1}  ${what}`);
      }
    });
  }
}

// A scan that matched nothing passes for the wrong reason: a moved directory or
// a typo in a glob would report success forever.
if (scanned === 0) {
  console.error("FAIL  the scan matched no files — the globs are wrong");
  process.exit(1);
}

/*
 * The Rust file layer, too. It has no HTTP client in its dependency tree, but
 * asserting that here means adding one is a build failure rather than a review
 * comment somebody might miss.
 */
const cargo = await Bun.file("packages/fs/Cargo.toml").text();
for (const crate of ["reqwest", "hyper", "ureq", "curl", "tokio-tungstenite"]) {
  if (new RegExp(`^\\s*${crate}\\s*=`, "m").test(cargo)) {
    violations.push(`packages/fs/Cargo.toml  ${crate}`);
  }
}

if (violations.length > 0) {
  console.error("FAIL  the application process must not reach the network:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`PASS  no network in ${scanned} files across core, agent, fs, and the desktop shell`);
