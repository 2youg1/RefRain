#!/usr/bin/env bun
/**
 * Everything that can fail must have a path that runs it.
 *
 * This release found three defects in the packaging configuration, an icon
 * that CI never generated, and a verification script that had been failing
 * unnoticed for weeks — all of them the same shape: a check existed, and
 * nothing ran it.
 *
 * A check nobody runs is worse than a missing one. It reads as coverage, and
 * `verify-anchor` did more than go stale: it manufactured a defect that was
 * written into SPEC as an open question and stayed there.
 */

import { Glob } from "bun";

// `Glob.scan` skips dotted directories by default, so `.github` needs asking
// for explicitly — the first draft of this script found nothing and would have
// passed for exactly the reason it exists to catch.
let ci = "";
for await (const file of new Glob("workflows/*.yml").scan({ cwd: ".github" })) {
  ci += await Bun.file(`.github/${file}`).text();
}

/*
 * Only lines that actually execute something count.
 *
 * Matching the whole file as one string meant a script's name appearing in a
 * comment satisfied the check. Disabling a gate — `run: echo skipped` — while
 * leaving "verify-themes.ts is temporarily disabled" above it passed here,
 * which is this gate's own failure mode wearing its own uniform.
 */
const commands = ci
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter(
    (line) => /^(run:|-\s*run:|\S+:\s*bun\s)/.test(line) || /^\s*(bun|npm|cargo)\s/.test(line),
  )
  .join("\n");

if (ci === "") {
  console.error("FAIL  no workflow files found — the scan is looking in the wrong place");
  process.exit(1);
}

const orphans: string[] = [];
const checked: string[] = [];

/*
 * Verification scripts. Anything named `verify-*` claims to assert something;
 * if CI does not invoke it, that claim is untested.
 */
// `**/scripts/` rather than the two directories that happen to hold gates
// today. Both spellings match the same thirty files right now; the difference
// arrives with the first gate added under a package nobody thought to list,
// which is the omission this script exists to notice.
for (const pattern of ["**/scripts/verify-*.ts"]) {
  for await (const file of new Glob(pattern).scan(".")) {
    // Split on either separator. Glob returns `scripts\verify-gate.ts` on
    // Windows, so splitting on "/" alone left the whole path as the filename
    // and every comparison against the workflow YAML — which spells its paths
    // with forward slashes — failed. This gate then reported all thirty-two
    // verification surfaces as orphans and failed the release, on the platform
    // the installer ships to and nowhere else.
    const name = file.split(/[/\\]/).pop() ?? file;
    checked.push(name);
    // Either invoked by path, or through a package.json script that CI calls.
    const byPath = commands.includes(name);
    const byScript = commands.includes(`verify:${name.replace(/^verify-|\.ts$/g, "")}`);
    if (!byPath && !byScript) orphans.push(file);
  }
}

/* Root package scripts named `verify:*` are gates by intent. */
const root = JSON.parse(await Bun.file("package.json").text()) as {
  scripts?: Record<string, string>;
};
for (const script of Object.keys(root.scripts ?? {})) {
  if (!script.startsWith("verify:")) continue;
  checked.push(script);
  if (!commands.includes(script)) orphans.push(`package.json script "${script}"`);
}

/*
 * The packaging configuration. Its schema is validated only when the packager
 * runs, and three of this release's defects lived there.
 */
if (!ci.includes("electron-builder")) {
  orphans.push("electron-builder (the packaging configuration is never validated)");
}

/* The native layer, whose tests only run where its platform binary builds. */
if (!ci.includes("cargo test")) {
  orphans.push("cargo test (the native file layer is never tested)");
}

// The CI side of this scan already guards against finding nothing. The gate
// side did not: move or rename the script directories and both globs match
// zero files, `orphans` stays empty, and this reports "checked 0" and passes —
// the exact failure it was written to catch, turned on itself.
if (checked.length === 0) {
  console.error(
    "FAIL  found no verification surfaces to check — the globs are looking in the wrong place",
  );
  process.exit(1);
}

console.log(`checked ${checked.length} verification surfaces`);

if (orphans.length > 0) {
  console.error("\nFAIL  these can fail, but nothing runs them:");
  for (const orphan of orphans) console.error(`  ${orphan}`);
  console.error("\nAdd them to a workflow, or delete them. A check nobody runs reads as");
  console.error("coverage while asserting nothing — and can invent defects of its own.");
  process.exit(1);
}

console.log("PASS  every verification surface has a path that runs it");
