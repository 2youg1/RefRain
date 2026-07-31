#!/usr/bin/env bun
import { readFileSync } from "node:fs";
/** Keeps the rejected editor kernel out of runtime code and dependencies. */

import { createHash } from "node:crypto";
import { collect } from "./gate-lib.ts";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface BoundaryProbe {
  readonly decision: string;
  readonly mismatched: number;
  readonly sourceOracle: { readonly file: string; readonly sha256: string };
}

const failures: string[] = [];
const manifests = collect(["package.json", "apps/*/package.json", "packages/*/package.json"]);
for (const file of manifests) {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as PackageManifest;
  for (const group of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const name of Object.keys(group ?? {})) {
      if (name.startsWith("prosemirror-")) failures.push(`${file}: rejected dependency ${name}`);
    }
  }
}

const sources = collect([
  "apps/**/*.{ts,tsx,vue}",
  "packages/**/*.{ts,tsx,vue}",
  "scripts/**/*.ts",
]).filter(
  (file) => file !== "scripts/verify-editor-kernel.ts" && file !== "scripts/prove-gates-bite.ts",
);
for (const file of sources) {
  if (/\bprosemirror(?:-|\b)/i.test(readFileSync(file, "utf8"))) {
    failures.push(`${file}: rejected ProseMirror runtime reference`);
  }
}

const probe = JSON.parse(
  readFileSync("probe-results/editor-boundaries.json", "utf8"),
) as BoundaryProbe;
const oracle = Buffer.from(readFileSync(probe.sourceOracle.file));
const oracleHash = createHash("sha256").update(oracle).digest("hex");
if (probe.decision !== "direct-dom") failures.push("boundary probe does not select direct-dom");
if (probe.mismatched < 1) failures.push("boundary probe records no falsifying corpus");
if (oracleHash !== probe.sourceOracle.sha256) {
  failures.push(`${probe.sourceOracle.file}: source oracle changed after the boundary probe`);
}

if (manifests.length === 0 || sources.length === 0) {
  failures.push(`empty scan: ${manifests.length} manifests and ${sources.length} source files`);
}
if (failures.length > 0) {
  console.error("FAIL  verify:editor-kernel: direct DOM decision drifted");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}
console.log(
  `PASS  verify:editor-kernel  (${manifests.length} manifests, ${sources.length} source files, ${probe.mismatched} falsifying corpora)`,
);
