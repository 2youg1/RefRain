#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which ScriptC compiles this repository.
 *
 * **What it connects to.** Every tier A gate and the release packager run as
 * ScriptC executables (`scriptc-tiers.ts`, roadmap D15). This module answers
 * the question that comes before "which programs": which compiler produced
 * them.
 *
 * **What it owns globally.** One invariant: *the compiler is the one
 * `bun.lock` resolved for the Native SDK, and nothing else.* Before this
 * module, `scripts/scriptc-build.ts` and `verify:scriptc-coverage` spawned
 * `scriptc` from PATH while `bun.lock` pinned a different version through the
 * SDK — so a tier A gate proved what the compiler on that machine happened to
 * do. The scar is exact: the workflows installed 0.0.21 globally while the
 * lockfile carried 0.0.35.
 *
 * **What can be reused.** `scriptcCommand()` by anything that must run the
 * compiler; running this file prints the bootstrap path, which is how
 * `release.yml` puts it in the environment.
 *
 * There is deliberately **no PATH fallback**. A fallback would mean the
 * lockfile was never the authority — the same argument that forbids the Bun
 * fallback for tier A gates. A machine without the dependency installed gets a
 * failure that names `bun install`, not a different compiler.
 *
 * The resolution reuses the one `gate.yml` already depends on for `NODE_PATH`:
 * bun installs a package's own dependencies beside it under
 * `node_modules/.bun/<name>@<version>/node_modules`, so the real path of the
 * SDK's link, two levels up, is the directory holding the SDK's dependencies.
 * Reusing it means the two cannot drift apart: a layout change breaks both at
 * once instead of leaving this one silently resolving to nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The SDK's link inside the workspace. `gate.yml` reads the same path. */
const SDK_LINK = join("apps", "native", "node_modules", "@native-sdk", "cli");

/** From the `bin` field of the `scriptc` package: `dist/bootstrap.js`. */
const BOOTSTRAP = join("scriptc", "dist", "bootstrap.js");

/** `scriptc` declares `engines.node >= 24`; bun cannot stand in for node here. */
const NODE = "node";

function fail(action: string, subject: string): never {
  throw new Error(
    `${action}: ${subject}\n` +
      "      The ScriptC compiler comes from the Native SDK's own dependencies,\n" +
      "      which `bun install` writes. There is no PATH fallback on purpose:\n" +
      "      a fallback compiles the gates with an unpinned compiler.",
  );
}

/** The bootstrap entry of the ScriptC that `bun.lock` resolved, absolute. */
export function scriptcBootstrap(): string {
  let sdk: string;
  try {
    sdk = realpathSync(SDK_LINK);
  } catch {
    return fail("cannot resolve the Native SDK", `${SDK_LINK} is not installed`);
  }
  const bootstrap = join(dirname(dirname(sdk)), BOOTSTRAP);
  if (!existsSync(bootstrap)) {
    return fail("cannot resolve ScriptC", `${bootstrap} is absent`);
  }
  return bootstrap;
}

/** The command that runs it. Callers spawn this, never the name `scriptc`. */
export function scriptcCommand(): readonly [string, string] {
  return [NODE, scriptcBootstrap()];
}

/** What the resolved compiler reports about itself. Throws rather than guess. */
export function scriptcVersion(): string {
  const [command, bootstrap] = scriptcCommand();
  const probe = spawnSync(command, [bootstrap, "--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return fail(
      "the resolved ScriptC did not run",
      `${bootstrap} exited ${probe.status ?? "on a signal"}`,
    );
  }
  return probe.stdout.trim();
}

// Running this file prints the bootstrap path. `release.yml` reads it into
// SCRIPTC_BOOTSTRAP so its PowerShell steps invoke the same compiler the gates
// do, without writing a version into the workflow.
if (import.meta.main) {
  console.log(scriptcBootstrap());
}
