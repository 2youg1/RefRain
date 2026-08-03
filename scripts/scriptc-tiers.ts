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
 */

/** Where `bun run scriptc:build` writes the executables. */
export const SCRIPTC_OUT = "target/scriptc";

/**
 * Tier A membership, by gate name. The value is the source script; the
 * executable is `${SCRIPTC_OUT}/<basename without .ts>`.
 */
export const TIER_A: Readonly<Record<string, string>> = {
  "verify:alternates-isolation": "scripts/verify-alternates-isolation.ts",
  "verify:bridge": "scripts/verify-bridge.ts",
  "verify:command-depth": "scripts/verify-command-depth.ts",
  "verify:component-depth": "scripts/verify-component-depth.ts",
  "verify:config-authority": "scripts/verify-config-authority.ts",
  "verify:contract-tier-per-task": "scripts/verify-contract-tier-per-task.ts",
  "verify:core-purity": "scripts/verify-core-purity.ts",
  "verify:editor-kernel": "scripts/verify-editor-kernel.ts",
  "verify:effect-territory": "scripts/verify-effect-territory.ts",
  "verify:font-licenses": "scripts/verify-font-licenses.ts",
  "verify:no-html-sink": "scripts/verify-no-html-sink.ts",
  "verify:no-js": "scripts/verify-no-js.ts",
  "verify:reactive-subscription": "scripts/verify-reactive-subscription.ts",
  "verify:release-version": "scripts/verify-release-version.ts",
  "verify:roundtrip": "scripts/verify-roundtrip.ts",
  "verify:skill-doc-current": "scripts/verify-skill-doc-current.ts",
  "verify:strata": "scripts/verify-strata.ts",
  "verify:trash-only": "scripts/verify-trash-only.ts",
  "verify:unsafe-surface": "scripts/verify-unsafe-surface.ts",
  "verify:verification-order": "scripts/verify-verification-order.ts",
};

/** The executable a tier A gate runs as. */
export function executableFor(script: string): string {
  const name = script.slice(script.lastIndexOf("/") + 1, -".ts".length);
  return `${SCRIPTC_OUT}/${name}`;
}
