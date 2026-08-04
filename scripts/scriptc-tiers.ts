#!/usr/bin/env bun
/**
 * ScriptC tier A: the gates that compile to native executables.
 *
 * A gate is tier A when `scriptc coverage` reports `fully static` — no dynamic
 * remainder, so the compiled program is the whole program. The gate then runs
 * as that executable and not as `bun scripts/*.ts`. There is no Bun fallback:
 * a fallback means the compiled artefact was never the authority, and a
 * ScriptC regression would turn no gate red (roadmap D15).
 *
 * Measured on this list, 20 gates, three rounds, best of each:
 * compiled 390 ms against Bun 586 ms — 196 ms saved per full gate run.
 *
 * Membership is verified, not declared: `verify:scriptc-coverage` re-runs
 * `scriptc coverage` over every build-time script and fails when a name here
 * is no longer fully static, or when a fully static script is missing here.
 * Step 10 deleted the gates that guarded the DOM/Solid/Tauri surface, so this
 * table shrank with them; three Native-era gates joined it in the same pass.
 */

/** Where `bun run scriptc:build` writes the executables. */
export const SCRIPTC_OUT = "target/scriptc";

/** ScriptC-compiled production programs that are not source-quality gates. */
export const RELEASE_ASSETS_SOURCE = "scripts/release-assets.ts";
export const RELEASE_PROGRAMS: Readonly<Record<string, string>> = {
  "release:assets": RELEASE_ASSETS_SOURCE,
};

/**
 * Tier A membership, by gate name. The value is the source script; the
 * executable is `${SCRIPTC_OUT}/<basename without .ts>`.
 */
export const TIER_A: Readonly<Record<string, string>> = {
  "verify:alternates-isolation": "scripts/verify-alternates-isolation.ts",
  "verify:bridge": "scripts/verify-bridge.ts",
  "verify:core-purity": "scripts/verify-core-purity.ts",
  "verify:corner-authority": "scripts/verify-corner-authority.ts",
  "verify:editor-kernel": "scripts/verify-editor-kernel.ts",
  "verify:effect-territory": "scripts/verify-effect-territory.ts",
  "verify:native-document-performance": "scripts/verify-native-document-performance.ts",
  "verify:native-ime": "scripts/verify-native-ime.ts",
  "verify:no-html-sink": "scripts/verify-no-html-sink.ts",
  "verify:release-version": "scripts/verify-release-version.ts",
  "verify:roundtrip": "scripts/verify-roundtrip.ts",
  "verify:skill-doc-current": "scripts/verify-skill-doc-current.ts",
  "verify:trash-only": "scripts/verify-trash-only.ts",
  "verify:unsafe-surface": "scripts/verify-unsafe-surface.ts",
  "verify:verification-order": "scripts/verify-verification-order.ts",
};

/** Every program that ScriptC must compile without a dynamic remainder. */
export const SCRIPTC_PROGRAMS: Readonly<Record<string, string>> = {
  ...TIER_A,
  ...RELEASE_PROGRAMS,
};

/** The executable a ScriptC source runs as. */
export function executableFor(script: string): string {
  const name = script.slice(script.lastIndexOf("/") + 1, -".ts".length);
  const suffix = process.platform === "win32" ? ".exe" : "";
  return `${SCRIPTC_OUT}/${name}${suffix}`;
}
