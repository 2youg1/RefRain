#!/usr/bin/env bun

// A type gate that cannot fail is worse than no gate: it reports success
// forever while the invariant it guards rots. This proves each type
// configuration still bites, by feeding it code that must be rejected.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { $ } from "bun";

/*
 * One suite per type configuration. `bun run check` is a chain of four
 * independent `tsc` runs, and `&&` stops at the first failure — so probing
 * `packages/core` alone proved the root config bites and said nothing about the
 * three under apps/desktop, where the runtime-boundary defects live: a main
 * process reaching for `document`, a renderer reaching for `Bun`. Each suite is
 * therefore written, checked, and removed on its own.
 */
const suites: ReadonlyArray<{
  readonly what: string;
  readonly dir: string;
  readonly check: string;
  readonly probes: Readonly<Record<string, string>>;
}> = [
  {
    what: "the shared core",
    dir: "packages/core/src/__gate_probe__",
    check: "check",
    probes: {
      // noUncheckedIndexedAccess
      "index-access.ts": "const xs: string[] = []; export const x: string = xs[0];",
      // noExplicitAny (biome) + strict
      "implicit-any.ts": "export const f = (x) => x;",
      // exactOptionalPropertyTypes
      "exact-optional.ts": "type T = { a?: string }; export const t: T = { a: undefined };",
    },
  },
  {
    what: "the main process, which is Node",
    dir: "apps/desktop/src/main/__gate_probe__",
    check: "check:main",
    probes: {
      "no-dom.ts": "export const title = (): string => document.title;",
      "no-bun.ts": "export const version = (): string => Bun.version;",
    },
  },
  {
    what: "the renderer, which is Chromium",
    dir: "apps/desktop/src/renderer/__gate_probe__",
    check: "check:renderer",
    probes: { "no-bun.ts": "export const version = (): string => Bun.version;" },
  },
];

/*
 * The probes are deliberately ill-typed source files inside the tree. They were
 * removed on the line after the check ran, which is fine until the run is
 * interrupted — a Ctrl+C or a CI timeout between the write and the remove
 * leaves files that fail the gate for everyone, forever, with nothing to say
 * where they came from.
 */
const clean = (): void => {
  for (const suite of suites) rmSync(suite.dir, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    clean();
    process.exit(130);
  });

const failures: string[] = [];

try {
  for (const suite of suites) {
    mkdirSync(suite.dir, { recursive: true });
    for (const [name, source] of Object.entries(suite.probes))
      writeFileSync(`${suite.dir}/${name}`, source);

    const result = await $`bun run ${suite.check}`.nothrow().quiet();
    const output = result.stdout.toString() + result.stderr.toString();

    if (result.exitCode === 0) {
      failures.push(`${suite.what}: accepted ill-typed probes — that gate is a no-op`);
    } else {
      const missed = Object.keys(suite.probes).filter((name) => !output.includes(name));
      if (missed.length > 0) failures.push(`${suite.what}: missed ${missed.join(", ")}`);
    }

    // Removed before the next suite runs, so one suite's probes cannot be what
    // reddens another's check.
    rmSync(suite.dir, { recursive: true, force: true });
  }
} finally {
  clean();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exit(1);
}

const total = suites.reduce((sum, suite) => sum + Object.keys(suite.probes).length, 0);
console.log(`PASS  ${total} probes rejected across ${suites.length} type configurations`);
