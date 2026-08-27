// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repository = join(import.meta.dir, "..");
const roots: string[] = [];

function repositoryWorkflow(name: string): string {
  return readFileSync(join(repository, ".github", "workflows", name), "utf8");
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "refrain-release-workflow-"));
  roots.push(root);
  for (const relative of [
    ".github/workflows/release.yml",
    ".github/workflows/gate.yml",
    ".github/workflows/ime-gate.yml",
    "package.json",
    "apps/native/build.zig",
    "apps/native/build-inputs/windows/runtimeobject.def",
  ]) {
    const destination = join(root, ...relative.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repository, ...relative.split("/")), destination);
  }
  return root;
}

function rewrite(root: string, relative: string, transform: (source: string) => string): void {
  const path = join(root, ...relative.split("/"));
  writeFileSync(path, transform(readFileSync(path, "utf8")));
}

function verify(root: string): ReturnType<typeof spawnSync> {
  return spawnSync("bun", ["scripts/verify-release-workflow.ts"], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, VERIFY_RELEASE_WORKFLOW_ROOT: root },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Native portable release workflows", () => {
  test("use Native binaries and the ScriptC portable ZIP path without legacy packagers", () => {
    const release = repositoryWorkflow("release.yml");
    const gate = repositoryWorkflow("gate.yml");
    const ime = repositoryWorkflow("ime-gate.yml");
    const all = `${release}\n${gate}\n${ime}`;

    expect(release).toContain("bun x native package --target windows");
    expect(release).toContain("rustup target add x86_64-pc-windows-gnu");
    expect(release).toContain("zig dlltool %*");
    expect(release).toContain("--binary zig-out/bin/refrain.exe");
    expect(release).toContain("target/scriptc/release-assets.exe");
    expect(release).toContain("release-assets/refrain-windows-x64.zip");
    expect(release).toContain("python3 -m zipfile -t");
    expect(gate).toContain("bun x native build . --yes -Dplatform=$" + "{{ matrix.platform }}");
    expect(gate).toContain("bun run e2e:journals");
    expect(ime).toContain("-Shell native");
    expect(ime).toContain("apps/native/zig-out/bin/refrain.exe");

    expect(all).not.toMatch(/tauri|nsis|msix|refrain-desktop|webview2|webkit/i);
    expect(release).not.toMatch(/bun\s+(?:run\s+)?scripts\/release-assets\.ts/);
    expect(release).not.toContain("Compress-Archive");
  });

  test("accepts the canonical Native portable workflow set", () => {
    const result = verify(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS  verify:release-workflow");
  });

  for (const injection of [
    {
      name: "Tauri release flow",
      file: ".github/workflows/release.yml",
      text: "\n# bun x tauri build --bundles nsis\n",
    },
    {
      name: "Bun release-version fallback",
      file: ".github/workflows/release.yml",
      text: "\n# bun run verify:release-version\n",
    },
    {
      name: "Bun release-program fallback",
      file: ".github/workflows/release.yml",
      text: "\n# bun scripts/release-assets.ts package 0.2.5 app out\n",
    },
    {
      name: "system ZIP packager",
      file: ".github/workflows/release.yml",
      text: "\n# zip -r release-assets/refrain-windows-x64.zip app\n",
    },
    {
      name: "Native SDK archive bypass",
      file: ".github/workflows/release.yml",
      text: "\n# bun x native package --target windows --archive\n",
    },
    {
      name: "unrelated WebKit dependency",
      file: ".github/workflows/gate.yml",
      text: "\n# sudo apt-get install libwebkit2gtk-4.1-dev\n",
    },
    {
      name: "legacy IME shell",
      file: ".github/workflows/ime-gate.yml",
      text: "\n# powershell drive.ps1 -Shell wv2\n",
    },
  ] as const) {
    test(`rejects ${injection.name}`, () => {
      const root = fixture();
      rewrite(root, injection.file, (source) => source + injection.text);
      const result = verify(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FAIL  verify:release-workflow");
    });
  }

  test("rejects an upload step that drops the portable ZIP", () => {
    const root = fixture();
    rewrite(root, ".github/workflows/release.yml", (source) =>
      source.replace("path: release-assets/refrain-windows-x64.zip", "path: release-assets"),
    );
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("upload only the portable ZIP");
  });

  test("rejects a Windows build that omits Cargo's matching GNU target", () => {
    const root = fixture();
    rewrite(root, ".github/workflows/release.yml", (source) =>
      source.replace("rustup target add x86_64-pc-windows-gnu", "rustup show"),
    );
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("match Cargo to the Native SDK Windows ABI");
  });

  test("rejects a GNU Rust build without the pinned Zig dlltool shim", () => {
    const root = fixture();
    rewrite(root, ".github/workflows/release.yml", (source) =>
      source.replace("zig dlltool %*", "echo missing dlltool"),
    );
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expose pinned Zig as Rust GNU dlltool");
  });

  test("rejects a RuntimeObject import that differs by one symbol", () => {
    const root = fixture();
    rewrite(root, "apps/native/build-inputs/windows/runtimeobject.def", (source) =>
      source.replace("RoGetActivationFactory", "RoGetActivationFactor"),
    );
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("import the one RuntimeObject symbol Rust requires");
  });

  test("rejects a Windows link that drops the Propsys conversion library", () => {
    const root = fixture();
    rewrite(root, "apps/native/build.zig", (source) =>
      source.replace('            "propsys",\n', ""),
    );
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resolve the PROPVARIANT conversion functions");
  });

  test("rejects packaging that can rebuild instead of consuming the proven executable", () => {
    const root = fixture();
    rewrite(root, ".github/workflows/release.yml", (source) =>
      source.replace("            --binary zig-out/bin/refrain.exe `\n", ""),
    );
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package the binary already proven by the ABI-aligned build");
  });
});
