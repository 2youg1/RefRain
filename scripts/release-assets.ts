#!/usr/bin/env node
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Build and verify the deterministic Windows portable archive. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ARCHIVE_NAME = "refrain-windows-x64.zip";
const PRODUCT_ROOT = "RefRain";
const MANIFEST_NAME = "release-manifest.json";
const SBOM_NAME = "refrain-windows-x64.cdx.json";
const HASHES_NAME = "SHA256SUMS";
const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_EOCD_MAGIC = 0x06054b50;
const ZIP_UTF8 = 0x0800;
const ZIP_DOS_DATE = 0x0021;
const REGULAR_FILE = 0o100000;
const MODE_READ_ONLY = 0o100644;
const MODE_EXECUTABLE = 0o100755;
const HEX_DIGITS: readonly string[] = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
];

const SHA256_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

interface ArchiveMember {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly path: string;
}

interface PreparedMember extends ArchiveMember {
  readonly crc32: number;
  readonly nameBytes: Buffer;
  localOffset: number;
}

function fail(message: string): never {
  process.stderr.write(`release-assets: ${message}\n`);
  process.exit(1);
}

function usage(): never {
  fail(
    "usage: release-assets package <version> <native-app-directory> <fresh-output-directory> | verify <archive> [version]",
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function hexadecimalWord(value: number): string {
  let text = "";
  for (let shift = 28; shift >= 0; shift -= 4) {
    const digit = HEX_DIGITS[(value >>> shift) & 0x0f];
    if (digit === undefined) fail("internal SHA-256 hexadecimal digit is missing");
    text += digit;
  }
  return text;
}

function sha256(bytes: Buffer): string {
  if (bytes.length > 0x1fffffff) fail("a member is too large for the SHA-256 implementation");
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = Buffer.alloc(paddedLength);
  bytes.copy(padded, 0);
  padded[bytes.length] = 0x80;
  padded.writeUInt32BE(Math.floor(bitLength / 0x100000000), paddedLength - 8);
  padded.writeUInt32BE(bitLength >>> 0, paddedLength - 4);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = [];
    for (let index = 0; index < 64; index += 1) words.push(0);
    for (let index = 0; index < 16; index += 1) {
      words[index] = padded.readUInt32BE(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(hexadecimalWord).join("");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateArchivePath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    fail(`unsafe archive member path: ${path}`);
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      fail(`unsafe archive member path: ${path}`);
    }
    validateWindowsSegment(path, segment);
  }
}

function validateWindowsSegment(path: string, segment: string): void {
  if (
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    segment.includes("<") ||
    segment.includes(">") ||
    segment.includes(":") ||
    segment.includes('"') ||
    segment.includes("|") ||
    segment.includes("?") ||
    segment.includes("*")
  ) {
    fail(`unsafe Windows member path: ${path}`);
  }
  const base = (segment.split(".")[0] ?? "").toUpperCase();
  for (const reserved of ["CON", "PRN", "AUX", "NUL"]) {
    if (base === reserved) fail(`unsafe Windows member path: ${path}`);
  }
  const prefix = base.slice(0, 3);
  const suffix = base.slice(3);
  if (
    (prefix === "COM" || prefix === "LPT") &&
    suffix.length === 1 &&
    suffix >= "1" &&
    suffix <= "9"
  ) {
    fail(`unsafe Windows member path: ${path}`);
  }
}

function windowsMemberKey(path: string): string {
  return path.toLowerCase();
}

function requireUniqueWindowsPaths(members: readonly ArchiveMember[]): void {
  const keys: string[] = [];
  for (const member of members) {
    const key = windowsMemberKey(member.path);
    for (const existing of keys) {
      if (existing === key) fail(`duplicate Windows member path: ${member.path}`);
    }
    keys.push(key);
  }
}

function collectPayload(root: string, relative = ""): ArchiveMember[] {
  const directory = relative === "" ? root : join(root, ...relative.split("/"));
  const members: ArchiveMember[] = [];
  for (const name of readdirSync(directory).sort(compareText)) {
    const childRelative = relative === "" ? name : `${relative}/${name}`;
    const child = join(root, ...childRelative.split("/"));
    const status = lstatSync(child);
    if (status.isSymbolicLink())
      fail(`Native application entry is a symbolic link: ${childRelative}`);
    if (status.isDirectory()) {
      members.push(...collectPayload(root, childRelative));
      continue;
    }
    if (!status.isFile()) fail(`Native application entry is not a regular file: ${childRelative}`);
    const path = `${PRODUCT_ROOT}/${childRelative}`;
    validateArchivePath(path);
    members.push({
      bytes: readFileSync(child),
      mode: childRelative.toLowerCase().endsWith(".exe") ? MODE_EXECUTABLE : MODE_READ_ONLY,
      path,
    });
  }
  return members;
}

function memberWithPath(members: readonly ArchiveMember[], path: string): ArchiveMember {
  for (const member of members) {
    if (member.path === path) return member;
  }
  fail(`Native application directory is missing ${path.slice(PRODUCT_ROOT.length + 1)}`);
}

function requireNativeApplication(payload: readonly ArchiveMember[], version: string): void {
  const executable = memberWithPath(payload, `${PRODUCT_ROOT}/bin/refrain.exe`);
  memberWithPath(payload, `${PRODUCT_ROOT}/app-icon.ico`);
  memberWithPath(payload, `${PRODUCT_ROOT}/README.txt`);
  const report = memberWithPath(payload, `${PRODUCT_ROOT}/package-manifest.zon`);
  if (executable.bytes.length < 2 || executable.bytes[0] !== 0x4d || executable.bytes[1] !== 0x5a) {
    fail("bin/refrain.exe is not a Windows executable (missing MZ magic)");
  }
  if (!payload.some((member) => member.path.startsWith(`${PRODUCT_ROOT}/resources/`))) {
    fail("Native application directory has no resources");
  }
  const reportText = report.bytes.toString("utf8");
  requireReportText(reportText, `.target = "windows"`, "Windows target");
  requireReportText(reportText, `.version = "${version}"`, `version ${version}`);
  requireReportText(reportText, `.executable = "refrain.exe"`, "refrain.exe executable");
  requireReportText(reportText, `.web_layer = "none (`, "native-only web layer");
  requireReportText(reportText, `.subsystem = "gui"`, "GUI subsystem");
}

function requireReportText(report: string, needle: string, label: string): void {
  if (!report.includes(needle)) fail(`package-manifest.zon does not declare ${label}`);
}

function manifestText(payload: readonly ArchiveMember[], version: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      product: "RefRain",
      version,
      platform: "windows-x64",
      asset: ARCHIVE_NAME,
      root: PRODUCT_ROOT,
      sbom: SBOM_NAME,
      hashes: HASHES_NAME,
      reproducibility: {
        input: "byte-identical Native application directory",
        archive: "byte-identical",
        signing: "sign application binaries before packaging; signature bytes are archive input",
      },
      members: payload.map((member) => ({
        path: member.path,
        bytes: member.bytes.length,
        sha256: sha256(member.bytes),
      })),
    },
    null,
    2,
  )}\n`;
}

function sbomText(payload: readonly ArchiveMember[], version: string): string {
  const fileReferences = payload.map((member) => `file:${member.path}`);
  return `${JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        timestamp: "1980-01-01T00:00:00Z",
        component: {
          type: "application",
          "bom-ref": "pkg:refrain/windows-x64",
          name: "RefRain",
          version,
          licenses: [{ license: { id: "MPL-2.0" } }],
        },
      },
      components: payload.map((member) => ({
        type: "file",
        "bom-ref": `file:${member.path}`,
        name: member.path,
        hashes: [{ alg: "SHA-256", content: sha256(member.bytes) }],
      })),
      dependencies: [{ ref: "pkg:refrain/windows-x64", dependsOn: fileReferences }],
    },
    null,
    2,
  )}\n`;
}

function hashesText(members: readonly ArchiveMember[]): string {
  return `${members.map((member) => `${sha256(member.bytes)}  ${member.path}`).join("\n")}\n`;
}

function byteEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function writeArchive(sourceMembers: readonly ArchiveMember[]): Buffer {
  if (sourceMembers.length > 0xffff) fail("ZIP64 is not supported: too many members");
  const prepared: PreparedMember[] = sourceMembers.map((member) => ({
    ...member,
    crc32: crc32(member.bytes),
    nameBytes: Buffer.from(member.path, "utf8"),
    localOffset: 0,
  }));
  let totalLength = 22;
  for (const member of prepared) {
    if (member.bytes.length > 0xffffffff)
      fail(`ZIP64 is not supported: ${member.path} is too large`);
    totalLength += 30 + member.nameBytes.length + member.bytes.length;
    totalLength += 46 + member.nameBytes.length;
  }
  if (totalLength > 0xffffffff) fail("ZIP64 is not supported: archive is too large");

  const archive = Buffer.alloc(totalLength);
  let offset = 0;
  for (const member of prepared) {
    member.localOffset = offset;
    archive.writeUInt32LE(ZIP_LOCAL_MAGIC, offset);
    archive.writeUInt16LE(20, offset + 4);
    archive.writeUInt16LE(ZIP_UTF8, offset + 6);
    archive.writeUInt16LE(0, offset + 8);
    archive.writeUInt16LE(0, offset + 10);
    archive.writeUInt16LE(ZIP_DOS_DATE, offset + 12);
    archive.writeUInt32LE(member.crc32, offset + 14);
    archive.writeUInt32LE(member.bytes.length, offset + 18);
    archive.writeUInt32LE(member.bytes.length, offset + 22);
    archive.writeUInt16LE(member.nameBytes.length, offset + 26);
    archive.writeUInt16LE(0, offset + 28);
    member.nameBytes.copy(archive, offset + 30);
    member.bytes.copy(archive, offset + 30 + member.nameBytes.length);
    offset += 30 + member.nameBytes.length + member.bytes.length;
  }

  const centralOffset = offset;
  for (const member of prepared) {
    archive.writeUInt32LE(ZIP_CENTRAL_MAGIC, offset);
    archive.writeUInt16LE(0x0314, offset + 4);
    archive.writeUInt16LE(20, offset + 6);
    archive.writeUInt16LE(ZIP_UTF8, offset + 8);
    archive.writeUInt16LE(0, offset + 10);
    archive.writeUInt16LE(0, offset + 12);
    archive.writeUInt16LE(ZIP_DOS_DATE, offset + 14);
    archive.writeUInt32LE(member.crc32, offset + 16);
    archive.writeUInt32LE(member.bytes.length, offset + 20);
    archive.writeUInt32LE(member.bytes.length, offset + 24);
    archive.writeUInt16LE(member.nameBytes.length, offset + 28);
    archive.writeUInt16LE(0, offset + 30);
    archive.writeUInt16LE(0, offset + 32);
    archive.writeUInt16LE(0, offset + 34);
    archive.writeUInt16LE(0, offset + 36);
    archive.writeUInt32LE((member.mode * 0x10000) >>> 0, offset + 38);
    archive.writeUInt32LE(member.localOffset, offset + 42);
    member.nameBytes.copy(archive, offset + 46);
    offset += 46 + member.nameBytes.length;
  }

  const centralLength = offset - centralOffset;
  archive.writeUInt32LE(ZIP_EOCD_MAGIC, offset);
  archive.writeUInt16LE(0, offset + 4);
  archive.writeUInt16LE(0, offset + 6);
  archive.writeUInt16LE(prepared.length, offset + 8);
  archive.writeUInt16LE(prepared.length, offset + 10);
  archive.writeUInt32LE(centralLength, offset + 12);
  archive.writeUInt32LE(centralOffset, offset + 16);
  archive.writeUInt16LE(0, offset + 20);
  return archive;
}

function sliceBytes(bytes: Buffer, start: number, length: number): Buffer {
  if (start < 0 || length < 0 || start + length > bytes.length)
    fail("ZIP field points outside the archive");
  const result = Buffer.alloc(length);
  bytes.copy(result, 0, start, start + length);
  return result;
}

function readArchive(archive: Buffer): ArchiveMember[] {
  if (archive.length < 22) fail("ZIP is truncated");
  const eocd = archive.length - 22;
  if (archive.readUInt32LE(eocd) !== ZIP_EOCD_MAGIC) fail("ZIP EOCD is missing or not final");
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0) {
    fail("multi-disk ZIP is not supported");
  }
  const count = archive.readUInt16LE(eocd + 10);
  if (archive.readUInt16LE(eocd + 8) !== count) fail("ZIP member counts disagree");
  const centralLength = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (centralOffset + centralLength !== eocd || archive.readUInt16LE(eocd + 20) !== 0) {
    fail("ZIP central directory is not canonical");
  }

  const members: ArchiveMember[] = [];
  const windowsKeys: string[] = [];
  let offset = centralOffset;
  let expectedLocalOffset = 0;
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_MAGIC) fail("ZIP central header is invalid");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const mode = archive.readUInt32LE(offset + 38) >>> 16;
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameBytes = sliceBytes(archive, offset + 46, nameLength);
    const path = nameBytes.toString("utf8");
    validateArchivePath(path);
    const windowsKey = windowsMemberKey(path);
    for (const existing of windowsKeys) {
      if (existing === windowsKey) fail(`duplicate Windows member path: ${path}`);
    }
    windowsKeys.push(windowsKey);
    if (flags !== ZIP_UTF8 || method !== 0 || compressedSize !== size) {
      fail(`ZIP member is not stored canonically: ${path}`);
    }
    if (extraLength !== 0 || commentLength !== 0 || (mode & 0o170000) !== REGULAR_FILE) {
      fail(`ZIP member metadata is not canonical: ${path}`);
    }
    const expectedMode = path.toLowerCase().endsWith(".exe") ? MODE_EXECUTABLE : MODE_READ_ONLY;
    if (mode !== expectedMode) fail(`ZIP member permissions are not canonical: ${path}`);
    if (
      localOffset !== expectedLocalOffset ||
      archive.readUInt32LE(localOffset) !== ZIP_LOCAL_MAGIC
    ) {
      fail(`ZIP local layout is not canonical: ${path}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localName = sliceBytes(archive, localOffset + 30, localNameLength);
    if (
      archive.readUInt16LE(localOffset + 6) !== flags ||
      archive.readUInt16LE(localOffset + 8) !== method ||
      archive.readUInt32LE(localOffset + 14) !== crc ||
      archive.readUInt32LE(localOffset + 18) !== size ||
      archive.readUInt32LE(localOffset + 22) !== size ||
      localExtraLength !== 0 ||
      !byteEqual(localName, nameBytes)
    ) {
      fail(`ZIP local and central headers disagree: ${path}`);
    }
    const contentOffset = localOffset + 30 + localNameLength;
    const bytes = sliceBytes(archive, contentOffset, size);
    if (crc32(bytes) !== crc) fail(`ZIP member CRC-32 mismatch: ${path}`);
    members.push({ bytes, mode, path });
    expectedLocalOffset = contentOffset + size;
    offset += 46 + nameLength;
  }
  if (offset !== eocd || expectedLocalOffset !== centralOffset)
    fail("ZIP contains hidden or trailing records");
  for (let index = 1; index < members.length; index += 1) {
    const previous = members[index - 1];
    const current = members[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareText(previous.path, current.path) >= 0
    ) {
      fail("ZIP members are not strictly sorted");
    }
  }
  return members;
}

function metadataMember(members: readonly ArchiveMember[], path: string): ArchiveMember {
  for (const member of members) {
    if (member.path === path) return member;
  }
  fail(`ZIP is missing ${path}`);
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verifyArchive(path: string, expectedVersion = ""): ArchiveMember[] {
  const members = readArchive(readFileSync(path));
  const payload = members.filter((member) => member.path.startsWith(`${PRODUCT_ROOT}/`));
  requireNativeApplication(
    payload,
    expectedVersion === "" ? manifestVersion(members) : expectedVersion,
  );
  const manifest = metadataMember(members, MANIFEST_NAME);
  const sbom = metadataMember(members, SBOM_NAME);
  const hashes = metadataMember(members, HASHES_NAME);
  const version = manifestVersion(members);
  if (expectedVersion !== "" && version !== expectedVersion) {
    fail(`archive version ${version} does not match expected ${expectedVersion}`);
  }
  const expectedManifest = Buffer.from(manifestText(payload, version), "utf8");
  const expectedSbom = Buffer.from(sbomText(payload, version), "utf8");
  if (!byteEqual(manifest.bytes, expectedManifest))
    fail(`${MANIFEST_NAME} does not match the payload`);
  if (!byteEqual(sbom.bytes, expectedSbom)) fail(`${SBOM_NAME} does not match the payload`);
  const expectedHashes = Buffer.from(
    hashesText([
      ...payload,
      { ...manifest, bytes: expectedManifest },
      { ...sbom, bytes: expectedSbom },
    ]),
    "utf8",
  );
  if (!byteEqual(hashes.bytes, expectedHashes))
    fail(`${HASHES_NAME} does not match the payload and metadata`);
  if (members.length !== payload.length + 3) fail("ZIP contains an undeclared top-level member");
  return members;
}

function manifestVersion(members: readonly ArchiveMember[]): string {
  const manifest = metadataMember(members, MANIFEST_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.bytes.toString("utf8"));
  } catch (error: unknown) {
    fail(`${MANIFEST_NAME} is not JSON: ${String(error)}`);
  }
  if (!objectRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    fail(`${MANIFEST_NAME} has no version`);
  }
  return parsed.version;
}

function packageApplication(version: string, appDirectory: string, outputDirectory: string): void {
  if (version.length === 0) fail("version is empty");
  if (!statSync(appDirectory).isDirectory())
    fail(`Native application path is not a directory: ${appDirectory}`);
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
    fail(`output directory is not empty: ${outputDirectory}`);
  }
  mkdirSync(outputDirectory, { recursive: true });

  const payload = collectPayload(appDirectory).sort((left, right) =>
    compareText(left.path, right.path),
  );
  requireUniqueWindowsPaths(payload);
  requireNativeApplication(payload, version);
  const manifest: ArchiveMember = {
    bytes: Buffer.from(manifestText(payload, version), "utf8"),
    mode: MODE_READ_ONLY,
    path: MANIFEST_NAME,
  };
  const sbom: ArchiveMember = {
    bytes: Buffer.from(sbomText(payload, version), "utf8"),
    mode: MODE_READ_ONLY,
    path: SBOM_NAME,
  };
  const hashes: ArchiveMember = {
    bytes: Buffer.from(hashesText([...payload, manifest, sbom]), "utf8"),
    mode: MODE_READ_ONLY,
    path: HASHES_NAME,
  };
  const members = [...payload, manifest, sbom, hashes].sort((left, right) =>
    compareText(left.path, right.path),
  );
  const archivePath = join(outputDirectory, ARCHIVE_NAME);
  writeFileSync(archivePath, writeArchive(members));
  const readBack = verifyArchive(archivePath, version);
  process.stdout.write(
    `prepared ${ARCHIVE_NAME} (${readBack.length} members, sha256=${sha256(readFileSync(archivePath))})\n`,
  );
}

function main(args: string[]): void {
  if (args.length === 0) usage();
  const command = args[0];
  if (command === "package") {
    if (args.length !== 4) usage();
    const version = args[1];
    const appDirectory = args[2];
    const outputDirectory = args[3];
    if (version === undefined || appDirectory === undefined || outputDirectory === undefined)
      usage();
    packageApplication(version, appDirectory, outputDirectory);
    return;
  }
  if (command === "verify") {
    if (args.length < 2 || args.length > 3) usage();
    const archive = args[1];
    const version = args[2] ?? "";
    if (archive === undefined) usage();
    const members = verifyArchive(archive, version);
    process.stdout.write(`verified ${ARCHIVE_NAME} (${members.length} members)\n`);
    return;
  }
  usage();
}

main(process.argv.slice(2));
