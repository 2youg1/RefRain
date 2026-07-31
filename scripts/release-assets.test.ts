import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  config: string;
  nsis: string;
  output: string;
  manifest: string;
} {
  const root = mkdtempSync(join(tmpdir(), "refrain-release-assets-"));
  roots.push(root);
  const config = join(root, "tauri.conf.json");
  const nsis = join(root, "nsis");
  const output = join(root, "public");
  mkdirSync(nsis);
  writeFileSync(config, '{"version":"0.2.1"}\n');
  writeFileSync(join(nsis, "Refrain_0.2.1_x64-setup.exe"), Uint8Array.from([0x4d, 0x5a, 1]));
  return { root, config, nsis, output, manifest: join(output, "release-manifest.json") };
}

function run(args: string[]) {
  return spawnSync("bun", ["scripts/release-assets.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
  });
}

describe("release asset policy", () => {
  test("prepares the exact installer and base manifest", async () => {
    const item = fixture();
    const result = run(["0.2.1", item.config, item.nsis, item.output]);
    expect(result.status).toBe(0);
    expect(existsSync(join(item.output, "refrain-windows-x64-setup.exe"))).toBe(true);
    expect(JSON.parse(readFileSync(item.manifest, "utf8"))).toEqual({
      schemaVersion: 1,
      version: "0.2.1",
      source: "Refrain_0.2.1_x64-setup.exe",
      asset: "refrain-windows-x64-setup.exe",
      bytes: 3,
    });
  });

  test("embeds a valid SPDX document into the public manifest", async () => {
    const item = fixture();
    expect(run(["0.2.1", item.config, item.nsis, item.output]).status).toBe(0);
    const sbom = join(item.root, "refrain-windows-x64.spdx.json");
    writeFileSync(sbom, '{"spdxVersion":"SPDX-2.3","SPDXID":"SPDXRef-DOCUMENT","packages":[]}\n');

    const result = run(["embed-sbom", item.manifest, sbom]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(item.manifest, "utf8"))).toMatchObject({
      schemaVersion: 1,
      version: "0.2.1",
      sbom: {
        spdxVersion: "SPDX-2.3",
        SPDXID: "SPDXRef-DOCUMENT",
        packages: [],
      },
    });
  });

  test("rejects a document that is not an SPDX SBOM", () => {
    const item = fixture();
    expect(run(["0.2.1", item.config, item.nsis, item.output]).status).toBe(0);
    const sbom = join(item.root, "invalid.json");
    writeFileSync(sbom, '{"packages":[]}\n');

    const result = run(["embed-sbom", item.manifest, sbom]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not an SPDX document");
  });
});
