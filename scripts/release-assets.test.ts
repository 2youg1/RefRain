import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");
const temporaryRoots: string[] = [];
const binaryRoot = mkdtempSync(join(tmpdir(), "refrain-release-assets-binary-"));
const binary = join(
  binaryRoot,
  process.platform === "win32" ? "release-assets.exe" : "release-assets",
);

beforeAll(() => {
  // 门禁链在 bun test 之前已经跑过 `bun run scriptc:build`，同一来源、同一
  // 编译器、同一次运行——直接复用它的产物。本机另起一次构建在 Windows 上
  // 会超过 hook 的默认预算，而 PATH 上的 `scriptc` 是个 .CMD，spawnSync
  // 不开 shell 执行不了它（这正是此处此前在 Windows 必红的两个原因）。
  const prebuilt = join(
    repository,
    "target",
    "scriptc",
    process.platform === "win32" ? "release-assets.exe" : "release-assets",
  );
  if (existsSync(prebuilt)) {
    copyFileSync(prebuilt, binary);
    return;
  }
  const result = spawnSync("scriptc", ["build", "scripts/release-assets.ts", "-o", binary], {
    cwd: repository,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stderr ?? ""}${result.stdout ?? ""}`);
  }
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(binaryRoot, { recursive: true, force: true });
});

interface Fixture {
  readonly app: string;
  readonly output: string;
  readonly root: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "refrain-release-assets-"));
  temporaryRoots.push(root);
  const app = join(root, "native-app");
  const output = join(root, "public");
  mkdirSync(join(app, "bin"), { recursive: true });
  mkdirSync(join(app, "resources"), { recursive: true });
  writeFileSync(join(app, "bin", "refrain.exe"), Uint8Array.from([0x4d, 0x5a, 0x90, 0]));
  writeFileSync(join(app, "app-icon.ico"), Uint8Array.from([0, 0, 1, 0]));
  writeFileSync(join(app, "README.txt"), "RefRain portable application\n");
  writeFileSync(join(app, "resources", "alpha.txt"), "alpha\n");
  writeFileSync(join(app, "resources", "omega.txt"), "omega\n");
  writeFileSync(
    join(app, "package-manifest.zon"),
    `. {\n  .target = "windows",\n  .version = "0.2.5",\n  .executable = "refrain.exe",\n  .web_layer = "none (declared: capabilities)",\n  .subsystem = "gui",\n}\n`.replace(
      ". {",
      ".{",
    ),
  );
  return { app, output, root };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ZipLocation {
  readonly centralOffset: number;
  readonly contentOffset: number;
  readonly localOffset: number;
  readonly size: number;
}

interface ZipMetadata {
  readonly method: number;
  readonly mode: number;
  readonly name: string;
  readonly time: number[];
}

function isZipMetadata(value: unknown): value is ZipMetadata[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("method" in item) ||
      typeof item.method !== "number" ||
      !("mode" in item) ||
      typeof item.mode !== "number" ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      !("time" in item)
    ) {
      return false;
    }
    const time: unknown = item.time;
    if (!Array.isArray(time)) return false;
    for (const part of time) {
      if (typeof part !== "number") return false;
    }
  }
  return true;
}

function zipLocation(archive: Buffer, expectedPath: string): ZipLocation {
  const eocd = archive.length - 22;
  let offset = archive.readUInt32LE(eocd + 16);
  const count = archive.readUInt16LE(eocd + 10);
  for (let index = 0; index < count; index += 1) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const path = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (path === expectedPath) {
      const localOffset = archive.readUInt32LE(offset + 42);
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      return {
        centralOffset: offset,
        contentOffset: localOffset + 30 + localNameLength + localExtraLength,
        localOffset,
        size: archive.readUInt32LE(offset + 24),
      };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP member not found: ${expectedPath}`);
}

function centralOffsetFor(archive: Buffer, expectedPath: string): number {
  return zipLocation(archive, expectedPath).centralOffset;
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

function rewriteMemberPath(archive: Buffer, from: string, to: string): void {
  const location = zipLocation(archive, from);
  const source = Buffer.from(from, "utf8");
  const target = Buffer.from(to, "utf8");
  if (source.length !== target.length)
    throw new Error("replacement ZIP path must preserve byte length");
  target.copy(archive, location.centralOffset + 46);
  target.copy(archive, location.localOffset + 30);
}

function tamperMemberContent(archive: Buffer, path: string): void {
  const location = zipLocation(archive, path);
  if (location.size === 0) throw new Error("cannot tamper with an empty ZIP member");
  archive[location.contentOffset] = (archive[location.contentOffset] ?? 0) ^ 0xff;
  const content = archive.subarray(location.contentOffset, location.contentOffset + location.size);
  const checksum = crc32(content);
  archive.writeUInt32LE(checksum, location.centralOffset + 16);
  archive.writeUInt32LE(checksum, location.localOffset + 14);
}

function verifyArchive(path: string) {
  return spawnSync(binary, ["verify", path, "0.2.5"], {
    cwd: repository,
    encoding: "utf8",
  });
}

function packageFixture(item: Fixture) {
  return spawnSync(binary, ["package", "0.2.5", item.app, item.output], {
    cwd: repository,
    encoding: "utf8",
  });
}

describe("ScriptC release archive", () => {
  test("compiled program rejects a missing command without aborting", () => {
    const result = spawnSync(binary, [], { cwd: repository, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("usage: release-assets package");
  });

  test("compiled program packages a Native directory as a self-verifying portable ZIP", () => {
    const item = fixture();
    const result = packageFixture(item);
    expect(result.status).toBe(0);

    const archive = join(item.output, "refrain-windows-x64.zip");
    expect(readdirSync(item.output)).toEqual(["refrain-windows-x64.zip"]);
    expect(existsSync(archive)).toBe(true);
    const archiveBytes = readFileSync(archive);
    expect(result.stdout).toContain(`sha256=${sha256(archiveBytes)}`);

    const python = process.platform === "win32" ? "python" : "python3";
    const tested = spawnSync(python, ["-m", "zipfile", "-t", archive], { encoding: "utf8" });
    expect(tested.status).toBe(0);

    const extracted = join(item.root, "extracted");
    const extraction = spawnSync(python, ["-m", "zipfile", "-e", archive, extracted], {
      encoding: "utf8",
    });
    expect(extraction.status).toBe(0);
    expect(readFileSync(join(extracted, "RefRain", "bin", "refrain.exe"))).toEqual(
      readFileSync(join(item.app, "bin", "refrain.exe")),
    );

    const manifest: unknown = JSON.parse(
      readFileSync(join(extracted, "release-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: "RefRain",
      version: "0.2.5",
      platform: "windows-x64",
      asset: "refrain-windows-x64.zip",
      root: "RefRain",
      sbom: "refrain-windows-x64.cdx.json",
      hashes: "SHA256SUMS",
    });

    const sbom: unknown = JSON.parse(
      readFileSync(join(extracted, "refrain-windows-x64.cdx.json"), "utf8"),
    );
    expect(sbom).toMatchObject({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: { component: { type: "application", name: "RefRain", version: "0.2.5" } },
    });

    const hashes = readFileSync(join(extracted, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("  "));
    for (const [expected, path] of hashes) {
      if (expected === undefined || path === undefined) {
        throw new Error("SHA256SUMS contains an incomplete row");
      }
      expect(sha256(readFileSync(join(extracted, path)))).toBe(expected);
    }
  });

  // 夹具要创建符号链接：Windows 上这需要开发者模式或管理员权限，否则
  // symlinkSync 直接 EPERM——红的是夹具而不是产品。Linux CI 照跑这道断言。
  test.skipIf(process.platform === "win32")(
    "rejects a source symlink that escapes the Native application directory",
    () => {
      const item = fixture();
      const outside = join(item.root, "outside.txt");
      writeFileSync(outside, "must not ship\n");
      symlinkSync(outside, join(item.app, "resources", "escape.txt"));

      const result = packageFixture(item);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("symbolic link");
    },
  );

  // 夹具要在同一目录里造出 ALPHA.TXT 与 alpha.txt 两个成员：Windows 的
  // 大小写不敏感文件系统让这份夹具根本造不出来（写 ALPHA.TXT 会覆盖
  // alpha.txt），所以这道断言只在大小写敏感的 CI 上跑得起来。
  test.skipIf(process.platform === "win32")(
    "rejects source members that collide on a Windows filesystem",
    () => {
      const item = fixture();
      writeFileSync(join(item.app, "resources", "ALPHA.TXT"), "collision\n");

      const result = packageFixture(item);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("duplicate Windows member path");
      expect(existsSync(join(item.output, "refrain-windows-x64.zip"))).toBe(false);
    },
  );

  test("rejects member names that Windows reserves or normalizes", () => {
    for (const name of ["alpha.txt.", "CON"]) {
      const item = fixture();
      writeFileSync(join(item.app, "resources", name), "unsafe\n");

      const result = packageFixture(item);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsafe Windows member path");
      expect(existsSync(join(item.output, "refrain-windows-x64.zip"))).toBe(false);
    }
  });

  test("rejects tampered member permissions during independent readback", () => {
    const item = fixture();
    expect(packageFixture(item).status).toBe(0);
    const archivePath = join(item.output, "refrain-windows-x64.zip");
    const archive = readFileSync(archivePath);
    const central = centralOffsetFor(archive, "refrain-windows-x64.cdx.json");
    archive.writeUInt32LE((0o100666 * 0x10000) >>> 0, central + 38);
    writeFileSync(archivePath, archive);

    const result = verifyArchive(archivePath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("permissions");
  });

  test("repackages byte-identical Native directories as byte-identical archives", () => {
    const first = fixture();
    const second = fixture();
    expect(packageFixture(first).status).toBe(0);
    expect(packageFixture(second).status).toBe(0);
    const firstArchive = join(first.output, "refrain-windows-x64.zip");
    const secondArchive = join(second.output, "refrain-windows-x64.zip");
    expect(readFileSync(firstArchive)).toEqual(readFileSync(secondArchive));

    const python = process.platform === "win32" ? "python" : "python3";
    const probe = spawnSync(
      python,
      [
        "-c",
        "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([{'name':i.filename,'time':i.date_time,'mode':i.external_attr>>16,'method':i.compress_type} for i in z.infolist()]))",
        firstArchive,
      ],
      { encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
    const metadata: unknown = JSON.parse(probe.stdout);
    expect(isZipMetadata(metadata)).toBe(true);
    if (!isZipMetadata(metadata)) throw new Error("Python ZIP metadata has an unexpected shape");
    for (const item of metadata) {
      expect(item.method).toBe(0);
      expect(item.time).toEqual([1980, 1, 1, 0, 0, 0]);
      expect(item.mode).toBe(item.name.toLowerCase().endsWith(".exe") ? 0o100755 : 0o100644);
    }
  });

  test("rejects a Native application directory with a missing required asset", () => {
    const item = fixture();
    rmSync(join(item.app, "bin", "refrain.exe"));

    const result = packageFixture(item);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing bin/refrain.exe");
  });

  test("rejects absolute and parent-traversal ZIP member paths", () => {
    for (const replacement of ["C:/escape0", "../escape0"]) {
      const item = fixture();
      expect(packageFixture(item).status).toBe(0);
      const archivePath = join(item.output, "refrain-windows-x64.zip");
      const archive = readFileSync(archivePath);
      rewriteMemberPath(archive, "SHA256SUMS", replacement);
      writeFileSync(archivePath, archive);

      const result = verifyArchive(archivePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsafe");
    }
  });

  test("rejects a duplicate ZIP member after Windows path normalization", () => {
    const item = fixture();
    expect(packageFixture(item).status).toBe(0);
    const archivePath = join(item.output, "refrain-windows-x64.zip");
    const archive = readFileSync(archivePath);
    rewriteMemberPath(archive, "RefRain/resources/omega.txt", "RefRain/resources/alpha.txt");
    writeFileSync(archivePath, archive);

    const result = verifyArchive(archivePath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate Windows member path");
  });

  test("rejects a symbolic-link mode injected into a ZIP member", () => {
    const item = fixture();
    expect(packageFixture(item).status).toBe(0);
    const archivePath = join(item.output, "refrain-windows-x64.zip");
    const archive = readFileSync(archivePath);
    const central = centralOffsetFor(archive, "RefRain/resources/alpha.txt");
    archive.writeUInt32LE((0o120777 * 0x10000) >>> 0, central + 38);
    writeFileSync(archivePath, archive);

    const result = verifyArchive(archivePath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("metadata");
  });

  test("rejects content tampering even when the attacker updates ZIP CRC-32", () => {
    const item = fixture();
    expect(packageFixture(item).status).toBe(0);
    const archivePath = join(item.output, "refrain-windows-x64.zip");
    const archive = readFileSync(archivePath);
    tamperMemberContent(archive, "RefRain/resources/alpha.txt");
    writeFileSync(archivePath, archive);

    const result = verifyArchive(archivePath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release-manifest.json does not match the payload");
  });
});
