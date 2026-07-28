#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const targets = [
  "crates/refrain-core/src/manuscript/align.rs",
  "crates/refrain-core/tests/review.rs",
] as const;
const missing = targets.filter((target) => !existsSync(target));
if (missing.length > 0) {
  console.error(`FAIL  verify:manuscript-scale: missing ${missing.join(", ")}`);
  process.exit(1);
}

const result = spawnSync("cargo", ["test", "-p", "refrain-core", "--test", "review"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error("FAIL  verify:manuscript-scale: crates/refrain-core/tests/review.rs");
  process.exit(result.status ?? 1);
}

console.log(`PASS  verify:manuscript-scale  (${targets.length} targets)`);
