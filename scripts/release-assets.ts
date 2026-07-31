#!/usr/bin/env node
/**
 * Prepare the exact public installer set for a RefRain release.
 *
 * This program is compiled by ScriptC and run as a native executable on the
 * Windows release runner. It owns the small but consequential policy between
 * "Tauri produced some files" and "these are the files we publish":
 *
 * - the requested version must equal tauri.conf.json;
 * - the NSIS directory must contain exactly one installer;
 * - the output directory must be new or empty;
 * - that installer must be non-empty and begin with the Windows MZ magic;
 * - the public filename is stable;
 * - one machine-readable manifest records the version, name and byte count.
 *
 * Build systems should not restate this policy in PowerShell. Keeping it here
 * gives the rule one implementation, one differential test surface, and one
 * native program that can be exercised before upload.
 */

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

function main(args: string[]): void {
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
