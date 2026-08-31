// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ScriptC release coverage gate", () => {
  test("rejects a dynamic remainder injected into the release program", () => {
    const root = mkdtempSync(join(tmpdir(), "refrain-scriptc-coverage-"));
    roots.push(root);
    const injected = join(root, "release-assets-dynamic.ts");
    writeFileSync(
      injected,
      `${readFileSync(join(repository, "scripts", "release-assets.ts"), "utf8")}\neval("dynamic remainder");\n`,
    );

    const result = spawnSync("bun", ["scripts/verify-scriptc-coverage.ts"], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, SCRIPTC_RELEASE_SOURCE: injected },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release-assets production program");
    expect(result.stderr).toContain("no longer compiles fully static");
  }, 120_000);
});
