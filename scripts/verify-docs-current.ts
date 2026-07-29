#!/usr/bin/env bun
/**
 * INV-16: protocol documentation is generated from the schema and can never
 * drift from the parser. The Rust target asserts the generated document
 * covers every error code and element the parser enforces; this gate runs it.
 *
 * Injection proof that this gate bites: delete an error code from the enum in
 * `crates/refrain-core/src/agent_protocol.rs` and the document silently
 * explains less than the parser rejects — the target fails, and so does this.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const targets = ["crates/refrain-core/src/agent_protocol.rs"] as const;
const missing = targets.filter((target) => !existsSync(target));
if (missing.length > 0) {
  console.error(`FAIL  verify:docs-current: missing ${missing.join(", ")}`);
  process.exit(1);
}

const result = spawnSync("cargo", ["test", "-p", "refrain-core", "docs_current"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error("FAIL  verify:docs-current: generated protocol docs drifted from the schema");
  process.exit(result.status ?? 1);
}

console.log(`PASS  verify:docs-current  (${targets.length} targets)`);
