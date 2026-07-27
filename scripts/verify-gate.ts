#!/usr/bin/env bun

// A type gate that cannot fail is worse than no gate: it reports success
// forever while the invariant it guards rots. This proves `bun run check`
// still bites, by feeding it code that must be rejected.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { $ } from "bun";

const dir = "packages/core/src/__gate_probe__";
const probes: Record<string, string> = {
  // noUncheckedIndexedAccess
  "index-access.ts": "const xs: string[] = []; export const x: string = xs[0];",
  // noExplicitAny (biome) + strict
  "implicit-any.ts": "export const f = (x) => x;",
  // exactOptionalPropertyTypes
  "exact-optional.ts": "type T = { a?: string }; export const t: T = { a: undefined };",
};

/**
 * The probes are deliberately ill-typed source files inside `packages/core`.
 * They were removed on the line after the check ran, which is fine until the
 * run is interrupted — a Ctrl+C or a CI timeout between the write and the
 * remove leaves three files that fail `bun run check` for everyone, forever,
 * with nothing to say where they came from.
 */
const clean = (): void => rmSync(dir, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    clean();
    process.exit(130);
  });

let exitCode: number;
let output: string;
try {
  mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(probes)) writeFileSync(`${dir}/${name}`, src);

  const result = await $`bun run check`.nothrow().quiet();
  exitCode = result.exitCode;
  output = result.stdout.toString() + result.stderr.toString();
} finally {
  clean();
}

const missed = Object.keys(probes).filter((name) => !output.includes(name));

if (exitCode === 0) {
  console.error("FAIL  typecheck accepted ill-typed probes -- the gate is a no-op");
  process.exit(1);
}
if (missed.length > 0) {
  console.error(`FAIL  typecheck missed: ${missed.join(", ")}`);
  process.exit(1);
}
console.log(`PASS  typecheck rejected all ${Object.keys(probes).length} probes`);
