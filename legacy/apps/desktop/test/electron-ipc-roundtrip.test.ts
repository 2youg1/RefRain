import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("Review Task protocol crosses the shipping Electron preload and authenticated IPC", () => {
  const source = join(root, "apps/desktop/scripts/verify-electron-ipc-roundtrip.ts");
  const build = readFileSync(join(root, "apps/desktop/scripts/build-desktop.ts"), "utf8");
  const workflowSource = readFileSync(join(root, ".github/workflows/gate.yml"), "utf8");
  const workflow = parse(workflowSource) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; if?: string; run?: string }> }>;
  };
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  expect(existsSync(source)).toBe(true);
  expect(build).toContain('"scripts/verify-electron-ipc-roundtrip.ts"');
  expect(build).toContain('"--outdir=build/checks"');
  expect(build).not.toContain('"dist/checks/verify-electron-ipc-roundtrip.cjs"');
  expect(rootPackage.scripts?.["verify:electron-ipc-roundtrip"]).toContain(
    "build/checks/verify-electron-ipc-roundtrip.cjs",
  );
  const steps = workflow.jobs?.native?.steps ?? [];
  const buildStep = steps.findIndex((step) => step.run === "bun run build:desktop");
  const roundtripStep = steps.findIndex(
    (step) => step.run === "bun run verify:electron-ipc-roundtrip",
  );
  expect(buildStep).toBeGreaterThanOrEqual(0);
  expect(roundtripStep).toBeGreaterThan(buildStep);
  expect(steps[roundtripStep]?.if).toBe("matrix.target == 'win32-x64'");
});
