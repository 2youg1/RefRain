/**
 * Build the platform binary and put it where the loader looks.
 *
 * Cargo names its output by platform convention; the loader wants one
 * predictable name per platform-arch pair so a packaged app can carry several
 * and pick one at run time. This script is the whole of that translation.
 */

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:process";

const here = new URL("..", import.meta.url).pathname;

const cargoOutput = (): string => {
  const release = join(here, "target", "release");
  const candidates = {
    linux: "librefrain_fs.so",
    darwin: "librefrain_fs.dylib",
    win32: "refrain_fs.dll",
  } as const;

  const name = candidates[platform as keyof typeof candidates];
  if (!name) throw new Error(`RefRain's file layer has no build recipe for ${platform}`);
  return join(release, name);
};

const built = cargoOutput();
if (!existsSync(built)) {
  console.error(`Cargo produced no artefact at ${built}.`);
  console.error("Run `cargo build --release` inside packages/fs first.");
  process.exit(1);
}

const destination = join(here, `refrain-fs.${platform}-${arch}.node`);
copyFileSync(built, destination);
console.log(`refrain-fs → ${destination}`);
