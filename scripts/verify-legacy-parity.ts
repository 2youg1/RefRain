#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";

import { Glob } from "bun";

const OWNERS = new Set([
  "manuscript",
  "agent-protocol",
  "kara",
  "config-store",
  "project-store",
  "root-files",
  "agent-host",
  "editor",
  "desktop",
  "repo-control",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const raw: unknown = JSON.parse(readFileSync("tests/legacy-parity.json", "utf8"));
if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
  console.error("FAIL  verify:legacy-parity: invalid ledger envelope");
  process.exit(1);
}

const current: string[] = [];
// At v0.2.0 the oracle is gone: a missing legacy/ tree maps to zero files,
// and every entry must already be owned or retired (enforced below).
if (existsSync("legacy")) {
  for await (const file of new Glob("**/*.test.ts").scan({ cwd: "legacy" })) {
    current.push(`legacy/${file.split(/[/\\]/).join("/")}`);
  }
}

const failures: string[] = [];
const seen = new Set<string>();
const counts = { blocked: 0, owned: 0, retired: 0 };

for (const [index, value] of raw.entries.entries()) {
  if (!isRecord(value)) {
    failures.push(`entry ${index} is not an object`);
    continue;
  }
  const legacy = value.legacy;
  const owner = value.owner;
  const disposition = value.disposition;
  if (typeof legacy !== "string" || !legacy.startsWith("legacy/") || !legacy.endsWith(".test.ts")) {
    failures.push(`entry ${index} has an invalid legacy path`);
    continue;
  }
  if (seen.has(legacy)) failures.push(`duplicate entry: ${legacy}`);
  seen.add(legacy);
  if (typeof owner !== "string" || !OWNERS.has(owner))
    failures.push(`${legacy} has invalid owner ${String(owner)}`);
  if (!isRecord(disposition) || typeof disposition.kind !== "string") {
    failures.push(`${legacy} has no disposition`);
    continue;
  }

  if (disposition.kind === "blocked") {
    counts.blocked += 1;
    if (
      typeof disposition.checkpoint !== "string" ||
      !/^C(?:[0-9]|1[0-4])$/.test(disposition.checkpoint)
    ) {
      failures.push(`${legacy} has invalid checkpoint ${String(disposition.checkpoint)}`);
    }
    if (!existsSync(legacy)) failures.push(`${legacy} was deleted while still blocked`);
  } else if (disposition.kind === "owned-by") {
    counts.owned += 1;
    if (!Array.isArray(disposition.tests) || disposition.tests.length === 0) {
      failures.push(`${legacy} claims ownership without final tests`);
    } else {
      for (const test of disposition.tests) {
        if (typeof test !== "string" || test.startsWith("legacy/") || !existsSync(test)) {
          failures.push(`${legacy} names missing or legacy test ${String(test)}`);
        }
      }
    }
  } else if (disposition.kind === "intentionally-retired") {
    counts.retired += 1;
    if (
      typeof disposition.authority !== "string" ||
      !/^SPEC D\d+(?:\/D\d+)?$/.test(disposition.authority)
    ) {
      failures.push(`${legacy} has invalid retirement authority ${String(disposition.authority)}`);
    }
  } else {
    failures.push(`${legacy} has unknown disposition ${disposition.kind}`);
  }
}

for (const path of current) if (!seen.has(path)) failures.push(`unmapped legacy test: ${path}`);

if (failures.length > 0) {
  console.error("FAIL  verify:legacy-parity");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:legacy-parity  (${seen.size} baseline files: ${counts.blocked} blocked, ${counts.owned} owned, ${counts.retired} retired)`,
);
