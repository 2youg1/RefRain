import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = process.env.REFRAIN_RELEASE_DIR ?? join(here, "..", "release");
const mode = process.argv[2];
const publishable = /(?:\.exe|\.dmg|\.AppImage|\.deb|\.spdx\.json|^SHA256SUMS)$/;
const assets = existsSync(root)
  ? readdirSync(root)
      .filter((name) => statSync(join(root, name)).isFile() && publishable.test(name))
      .sort()
  : [];

if (mode === "empty") {
  if (assets.length > 0)
    throw new Error(
      `package output is not fresh; move these assets out of ${root} before packaging: ${assets.join(", ")}`,
    );
  console.log(`PASS package output has no stale publishable assets: ${root}`);
} else if (mode === "windows-x64") {
  const installers = assets.filter((name) => /^RefRain-.+-windows-x64-Setup\.exe$/.test(name));
  if (installers.length !== 1 || assets.length !== 1)
    throw new Error(
      `expected one authoritative Windows x64 installer in ${root}; found: ${assets.join(", ") || "nothing"}`,
    );
  console.log(`PASS authoritative package asset: ${installers[0]}`);
} else {
  throw new Error("usage: bun scripts/verify-package-assets.ts empty|windows-x64");
}
