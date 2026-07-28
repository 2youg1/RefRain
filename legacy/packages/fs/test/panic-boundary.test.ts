import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const panicAddonArtifact = (): string => {
  switch (process.platform) {
    case "win32":
      return join(ROOT, "target", "release", "examples", "panic_boundary_addon.dll");
    case "darwin":
      return join(ROOT, "target", "release", "examples", "libpanic_boundary_addon.dylib");
    default:
      return join(ROOT, "target", "release", "examples", "libpanic_boundary_addon.so");
  }
};

test("a release N-API panic becomes a JS error without killing the process", () => {
  const build = spawnSync("cargo", ["build", "--release", "--example", "panic-boundary-addon"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(`${build.stdout}${build.stderr}`).not.toContain("error:");
  expect(build.status).toBe(0);

  const scratch = join(tmpdir(), `refrain-panic-boundary-${process.pid}`);
  const addon = join(scratch, "panic-boundary-addon.node");
  mkdirSync(scratch, { recursive: true });
  copyFileSync(panicAddonArtifact(), addon);

  try {
    const child = spawnSync(
      "node",
      [
        "-e",
        `const addon = require(${JSON.stringify(addon)});
try {
  addon.panicAtNapiBoundary();
  console.error("A10_PANIC_RETURNED");
  process.exit(90);
} catch (error) {
  if (!String(error).includes("A-10 panic boundary probe")) {
    console.error("A10_WRONG_ERROR", error);
    process.exit(91);
  }
  console.log("A10_NAPI_PANIC_CAUGHT");
}
if (addon.boundarySurvived() !== "alive-after-panic") {
  console.error("A10_PROCESS_DID_NOT_SURVIVE");
  process.exit(92);
}
console.log("A10_PROCESS_SURVIVED");`,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );

    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("A10_NAPI_PANIC_CAUGHT");
    expect(child.stdout).toContain("A10_PROCESS_SURVIVED");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // The build above is normally a no-op: CI warms this example before the
  // suite, and a developer's target directory is warm too. The budget covers
  // the cold case rather than assuming it away — 30s was enough for an
  // incremental rebuild and not for a first one, so this failed only on the
  // machine that had never built it, which is the release runner.
}, 300_000);
