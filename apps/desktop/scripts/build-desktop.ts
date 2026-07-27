import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const bun = process.execPath;

const run = async (args: string[], env?: Record<string, string>): Promise<void> => {
  const child = Bun.spawn([bun, ...args], {
    cwd: desktop,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`bun ${args.join(" ")} exited ${code}`);
};

const replaceGenerated = (from: string, to: string): void => {
  const source = join(desktop, from);
  const destination = join(desktop, to);
  rmSync(destination, { force: true });
  renameSync(source, destination);
};

await run(["x", "vite", "build"]);
await run([
  "build",
  "src/main/main.ts",
  "--target=node",
  "--outdir=dist/main",
  "--format=cjs",
  "--external",
  "electron",
]);
await run([
  "build",
  "src/main/preload.ts",
  "--target=node",
  "--outdir=dist/main",
  "--format=cjs",
  "--external",
  "electron",
]);
replaceGenerated("dist/main/main.js", "dist/main/main.cjs");
replaceGenerated("dist/main/preload.js", "dist/main/preload.cjs");

// A Bun global in the Node-targeted main bundle is a release-time crash.
await run(["scripts/verify-no-bun.ts"]);

// Exercise core under the exact Node embedded in the pinned Electron.
await run([
  "build",
  "scripts/node-ledger-check.ts",
  "--target=node",
  "--outdir=dist/checks",
  "--format=cjs",
]);
replaceGenerated("dist/checks/node-ledger-check.js", "dist/checks/node-ledger-check.cjs");
await run(["x", "electron", "dist/checks/node-ledger-check.cjs"], { ELECTRON_RUN_AS_NODE: "1" });

await run(["scripts/build-manifest.ts"]);

const icon = join(desktop, "build/icon.png");
if (!existsSync(icon) || statSync(icon).size === 0)
  throw new Error("MISSING build/icon.png — run 'bun scripts/make-icon.ts'");

console.log("BUILD_OK");
