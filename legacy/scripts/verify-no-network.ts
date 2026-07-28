#!/usr/bin/env bun
// SPEC 1.3: no application process may make an outbound request. Source
// inspection catches a capability before it ships; reviewed bundle inspection
// catches what the compiler actually left in main, preload, and renderer bytes.

import { auditNoNetwork } from "./no-network-policy.ts";

const audit = await auditNoNetwork(process.cwd());
if (audit.problems.length > 0 || audit.violations.length > 0) {
  console.error("FAIL  the application process must not reach the network:");
  for (const problem of audit.problems) console.error(`  ${problem}`);
  for (const violation of audit.violations)
    console.error(`  ${violation.path}:${violation.line}  ${violation.what}`);
  process.exit(1);
}

console.log(
  `PASS  no network in ${audit.scannedSources} source files and ${audit.scannedBundles} reviewed application bundles`,
);
