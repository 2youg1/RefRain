import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const verifier = join(here, "..", "scripts", "verify-package-assets.ts");

const run = (root: string, mode: string) =>
  spawnSync(process.execPath, [verifier, mode], {
    env: { ...process.env, REFRAIN_RELEASE_DIR: root },
    encoding: "utf8",
  });

test("package certification refuses a stale sibling asset and accepts one exact installer", () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-package-assets-"));
  try {
    expect(run(root, "empty").status).toBe(0);

    writeFileSync(join(root, "RefRain-0.1.5-windows-x64-Setup.exe"), "old");
    const stale = run(root, "empty");
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("package output is not fresh");

    rmSync(join(root, "RefRain-0.1.5-windows-x64-Setup.exe"));
    writeFileSync(join(root, "RefRain-0.1.6-windows-x64-Setup.exe"), "current");
    expect(run(root, "windows-x64").status).toBe(0);

    writeFileSync(join(root, "RefRain-0.1.6-linux-x64.AppImage"), "foreign");
    expect(run(root, "windows-x64").status).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
