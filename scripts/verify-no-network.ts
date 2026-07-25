#!/usr/bin/env bun
// SPEC 1.3: the app process makes no outbound network requests. A stray
// import survives code review easily, so the rule is enforced mechanically.

import { Glob } from "bun";

const banned = [
  { pattern: /\bfetch\s*\(/, what: "fetch()" },
  { pattern: /\bXMLHttpRequest\b/, what: "XMLHttpRequest" },
  { pattern: /\bWebSocket\b/, what: "WebSocket" },
  { pattern: /\bEventSource\b/, what: "EventSource" },
  { pattern: /from\s+["']node:(https?|net|dgram|dns|tls)["']/, what: "node network module" },
];

const violations: string[] = [];
for await (const file of new Glob("packages/core/src/**/*.ts").scan(".")) {
  const text = await Bun.file(file).text();
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("//")) return;
    for (const { pattern, what } of banned)
      if (pattern.test(line)) violations.push(`${file}:${i + 1}  ${what}`);
  });
}

if (violations.length > 0) {
  console.error("FAIL  packages/core must not reach the network:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("PASS  packages/core makes no network calls");
