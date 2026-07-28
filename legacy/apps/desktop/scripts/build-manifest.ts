import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktop = join(here, "..");
const dist = join(desktop, "dist");

const filesUnder = (root: string): string[] =>
  readdirSync(root)
    .flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    })
    .sort();

const names = (directory: string): string[] =>
  readdirSync(join(dist, directory))
    .filter((name) => statSync(join(dist, directory, name)).isFile())
    .sort();

const exact = (directory: string, expected: readonly string[]): void => {
  const actual = names(directory);
  if (actual.join("\n") !== [...expected].sort().join("\n"))
    throw new Error(
      `unexpected ${directory} build shape; expected ${expected.join(", ")}, found ${actual.join(", ")}`,
    );
};

exact("main", ["main.cjs", "preload.cjs"]);
exact("checks", ["node-ledger-check.cjs"]);

const files = filesUnder(dist).map((path) => {
  const bytes = readFileSync(path);
  return {
    path: relative(desktop, path).split("\\").join("/"),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});
if (!files.some((file) => file.path === "dist/renderer/index.html"))
  throw new Error("renderer build has no index.html");

const manifest = `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
const output = join(desktop, "build", "desktop-manifest.json");
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== manifest)
    throw new Error("build/desktop-manifest.json does not describe the current dist bytes");
  console.log(`PASS ${files.length} desktop build files match the committed manifest`);
} else {
  writeFileSync(output, manifest, "utf8");
  console.log(`WROTE ${files.length} desktop build files to build/desktop-manifest.json`);
}
