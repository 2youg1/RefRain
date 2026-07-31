#!/usr/bin/env node
/** Own the exact public installer, manifest, and embedded SBOM policy. */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const PUBLIC_INSTALLER = "refrain-windows-x64-setup.exe";
const PUBLIC_MANIFEST = "release-manifest.json";

function fail(message: string): never {
  process.stderr.write(`release-assets: ${message}\n`);
  process.exit(1);
}

function usage(): never {
  fail("usage: release-assets <version> <tauri.conf.json> <nsis-directory> <output-directory>");
}

function requireVersion(configPath: string, expected: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error: unknown) {
    fail(`cannot parse ${configPath}: ${String(error)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof (parsed as { version: unknown }).version !== "string"
  ) {
    fail(`${configPath} has no string version`);
  }
  const actual = (parsed as { version: string }).version;
  if (actual !== expected) {
    fail(`requested ${expected}, but ${configPath} says ${actual}`);
  }
}

function selectInstaller(directory: string): string {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".exe"));
  } catch (error: unknown) {
    fail(`cannot read NSIS directory ${directory}: ${String(error)}`);
  }
  if (names.length !== 1) {
    fail(`expected exactly one NSIS installer in ${directory}, found ${names.length}`);
  }
  return join(directory, names[0] ?? fail("installer name disappeared"));
}

function verifyInstaller(path: string): number {
  const size = statSync(path).size;
  if (size < 2) fail(`${path} is empty or truncated (${size} bytes)`);
  const bytes = readFileSync(path);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    fail(`${path} is not a Windows executable (missing MZ magic)`);
  }
  return size;
}

function embedSbom(manifestPath: string, sbomPath: string): void {
  let manifest: unknown;
  let sbom: unknown;
  let sbomText = "";
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    sbomText = readFileSync(sbomPath, "utf8");
    sbom = JSON.parse(sbomText);
  } catch (error: unknown) {
    fail(`cannot parse release metadata: ${String(error)}`);
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    !("schemaVersion" in manifest) ||
    !("version" in manifest) ||
    !("source" in manifest) ||
    !("asset" in manifest) ||
    !("bytes" in manifest) ||
    (manifest as { schemaVersion: unknown }).schemaVersion !== 1 ||
    typeof (manifest as { version: unknown }).version !== "string" ||
    typeof (manifest as { source: unknown }).source !== "string" ||
    (manifest as { asset: unknown }).asset !== PUBLIC_INSTALLER ||
    typeof (manifest as { bytes: unknown }).bytes !== "number"
  ) {
    fail(`${manifestPath} is not a release manifest`);
  }
  if (
    typeof sbom !== "object" ||
    sbom === null ||
    Array.isArray(sbom) ||
    !("spdxVersion" in sbom) ||
    !("SPDXID" in sbom) ||
    typeof (sbom as { spdxVersion: unknown }).spdxVersion !== "string" ||
    !(sbom as { spdxVersion: string }).spdxVersion.startsWith("SPDX-") ||
    (sbom as { SPDXID: unknown }).SPDXID !== "SPDXRef-DOCUMENT"
  ) {
    fail(`${sbomPath} is not an SPDX document`);
  }
  const base = manifest as {
    version: string;
    source: string;
    asset: string;
    bytes: number;
  };
  writeFileSync(
    manifestPath,
    `{\n  "schemaVersion": 1,\n  "version": ${JSON.stringify(base.version)},\n  "source": ${JSON.stringify(base.source)},\n  "asset": ${JSON.stringify(base.asset)},\n  "bytes": ${base.bytes},\n  "sbom": ${sbomText.trim()}\n}\n`,
  );
  process.stdout.write(`embedded ${basename(sbomPath)} in ${basename(manifestPath)}\n`);
}

function main(args: string[]): void {
  if (args[0] === "embed-sbom") {
    if (args.length !== 3 || !args[1] || !args[2]) {
      fail("usage: release-assets embed-sbom <release-manifest.json> <spdx.json>");
    }
    embedSbom(args[1], args[2]);
    return;
  }
  if (args.length !== 4) usage();
  const [version, configPath, nsisDirectory, outputDirectory] = args;
  if (!version || !configPath || !nsisDirectory || !outputDirectory) usage();

  requireVersion(configPath, version);
  const source = selectInstaller(nsisDirectory);
  const bytes = verifyInstaller(source);
  if (existsSync(outputDirectory)) {
    const stale = readdirSync(outputDirectory);
    if (stale.length > 0) {
      fail(`output directory is not empty: ${stale.join(", ")}`);
    }
  }
  mkdirSync(outputDirectory, { recursive: true });
  const destination = join(outputDirectory, PUBLIC_INSTALLER);
  copyFileSync(source, destination);
  writeFileSync(
    join(outputDirectory, PUBLIC_MANIFEST),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version,
        source: basename(source),
        asset: PUBLIC_INSTALLER,
        bytes,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`prepared ${PUBLIC_INSTALLER} (${bytes} bytes) for v${version}\n`);
}

main(process.argv.slice(2));
