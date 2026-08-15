#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.VERIFY_RELEASE_WORKFLOW_ROOT ?? ".";
const releaseFile = ".github/workflows/release.yml";
const gateFile = ".github/workflows/gate.yml";
const imeFile = ".github/workflows/ime-gate.yml";
const packageFile = "package.json";
const nativeBuildFile = "apps/native/build.zig";
const runtimeObjectFile = "apps/native/build-inputs/windows/runtimeobject.def";
const failures: string[] = [];

function read(relative: string): string {
  try {
    return readFileSync(join(root, ...relative.split("/")), "utf8");
  } catch (error: unknown) {
    failures.push(`${relative}: cannot read required workflow surface: ${String(error)}`);
    return "";
  }
}

const release = read(releaseFile);
const gate = read(gateFile);
const ime = read(imeFile);
const packageJson = read(packageFile);
const nativeBuild = read(nativeBuildFile);
const runtimeObject = read(runtimeObjectFile);
const workflows = `${release}\n${gate}\n${ime}`;

function requireLiteral(file: string, text: string, literal: string, meaning: string): void {
  if (!text.includes(literal)) failures.push(`${file}: ${meaning}; missing ${literal}`);
}

function forbidPattern(file: string, text: string, pattern: RegExp, meaning: string): void {
  const match = text.match(pattern)?.[0];
  if (match !== undefined) failures.push(`${file}: ${meaning}; found ${match}`);
}

const releaseRequirements: ReadonlyArray<readonly [string, string]> = [
  ["bun x native build . --yes -Dplatform=windows", "build the Native Windows binary"],
  ["rustup target add x86_64-pc-windows-gnu", "match Cargo to the Native SDK Windows ABI"],
  ["zig dlltool %*", "expose pinned Zig as Rust GNU dlltool"],
  ["bun x native package --target windows", "obtain the Native application directory"],
  ["--output ../../target/native/refrain-windows-x64", "write one closed application directory"],
  [
    "--binary zig-out/bin/refrain.exe",
    "package the binary already proven by the ABI-aligned build",
  ],
  ["--web-layer exclude", "exclude the legacy web layer"],
  ["--signing none", "declare the unsigned portable-package boundary"],
  ["scriptc build scripts/verify-release-version.ts", "compile the release version gate"],
  ["target/scriptc/verify-release-version.exe", "run the compiled release version gate"],
  ["scriptc coverage scripts/release-assets.ts", "measure the production release program"],
  ["if ($coverage -notmatch 'fully static')", "fail on a ScriptC dynamic remainder"],
  ["scriptc build scripts/release-assets.ts", "compile the production release program"],
  ["target/scriptc/release-assets.exe", "run the ScriptC-compiled release program"],
  ["release-assets-repeat", "build a second archive from the same input"],
  ["Get-FileHash -Algorithm SHA256", "compare both package byte hashes"],
  ["Expand-Archive -LiteralPath", "read the archive with an independent Windows extractor"],
  ["target/scriptc/release-assets.exe verify", "read the archive with the release program"],
  ["release-assets/refrain-windows-x64.zip", "name the only public portable asset"],
  ["path: release-assets/refrain-windows-x64.zip", "upload only the portable ZIP"],
  ["python3 -m zipfile -t", "test the downloaded ZIP with a standard extractor"],
  ["python3 -m zipfile -e", "extract the downloaded ZIP into a fresh directory"],
  ["sha256sum --check SHA256SUMS", "verify every extracted content hash"],
  ["release-manifest.json", "read back the embedded release manifest"],
  ["refrain-windows-x64.cdx.json", "read back the embedded CycloneDX SBOM"],
  ["gh release create", "publish the verified portable asset"],
];
for (const [literal, meaning] of releaseRequirements) {
  requireLiteral(releaseFile, release, literal, meaning);
}

let packageRuns = 0;
for (const match of release.matchAll(/& target\/scriptc\/release-assets\.exe package/g)) {
  if (match[0] !== "") packageRuns += 1;
}
if (packageRuns !== 2) {
  failures.push(`${releaseFile}: run the compiled packager exactly twice; found ${packageRuns}`);
}
requireLiteral(
  releaseFile,
  release,
  'test "$(find release-assets -maxdepth 1 -type f | wc -l)" -eq 1',
  "publish exactly one downloaded asset",
);
requireLiteral(
  releaseFile,
  release,
  "release-assets/refrain-windows-x64.zip\n",
  "pass only the portable ZIP to gh release create",
);

const gateRequirements: ReadonlyArray<readonly [string, string]> = [
  ["platform: linux", "define the Native Linux build"],
  ["platform: windows", "define the Native Windows build"],
  ["platform: macos", "define the Native macOS build"],
  ["rustup target add x86_64-pc-windows-gnu", "match the Windows Cargo and Native SDK ABIs"],
  ["x86_64-w64-mingw32-dlltool.cmd", "expose Zig dlltool under Rust's prefixed name"],
  [
    "bun x native build . --yes -Dplatform=$" + "{{ matrix.platform }}",
    "build the Native platform binary",
  ],
  ["bun run e2e:journals", "replay one journal per destination through Native automation"],
  ["apps/native/$" + "{{ matrix.binary }}", "upload the Native Windows debug binary"],
];
for (const [literal, meaning] of gateRequirements) {
  requireLiteral(gateFile, gate, literal, meaning);
}

// The IME evidence chain is: build the shipping binary, drive the real OS
// input method against it, then assert the recorded run. `assert-native.ts` is
// the acceptance authority — the driver calls it and fails the job on a
// non-zero exit. The old WebView2 analyzer pair went out with the web layer.
const imeRequirements: ReadonlyArray<readonly [string, string]> = [
  ["bun x native build . --yes -Dplatform=windows", "build the Native Windows IME target"],
  ["rustup target add x86_64-pc-windows-gnu", "match the IME binary's Cargo and Native SDK ABIs"],
  ["x86_64-w64-mingw32-dlltool.cmd", "expose Zig dlltool to the IME Rust build"],
  ["-Shell native", "drive the Native IME harness"],
  ["-Binary apps/native/zig-out/bin/refrain.exe", "name the real Native IME binary"],
  ["bun e2e/ime/assert-native.ts", "enforce Native IME acceptance"],
  ["e2e/ime/results/native", "keep the Native IME evidence root"],
];
for (const [literal, meaning] of imeRequirements) {
  requireLiteral(imeFile, ime, literal, meaning);
}

for (const [file, text] of [
  [releaseFile, release],
  [gateFile, gate],
  [imeFile, ime],
] as const) {
  requireLiteral(
    file,
    text,
    "version: $" + "{{ env.ZIG_VERSION }}",
    "pin the Native SDK Zig compiler",
  );
}
requireLiteral(releaseFile, release, 'ZIG_VERSION: "0.16.0"', "use the Native SDK Zig version");
requireLiteral(gateFile, gate, 'ZIG_VERSION: "0.16.0"', "use the Native SDK Zig version");
requireLiteral(imeFile, ime, 'ZIG_VERSION: "0.16.0"', "use the Native SDK Zig version");

const forbiddenWorkflowPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/tauri/i, "legacy application shell returned"],
  [/nsis/i, "installer packaging returned"],
  [/msix/i, "installer packaging returned"],
  [/refrain-desktop/i, "legacy desktop binary returned"],
  [/webview2|\bwv2\b/i, "legacy embedded-browser IME path returned"],
  [/webkit/i, "unrelated embedded-browser dependency returned"],
  [/playwright/i, "browser automation returned to the Native gate"],
  [/Compress-Archive/i, "a second ZIP packager returned"],
  [/\bzip\s+(?:-[A-Za-z]|--)/i, "the system ZIP packager returned"],
  [/\b7z\s/i, "a second archive packager returned"],
  [/\btar\s+(?:-[A-Za-z]|--)/i, "a second archive packager returned"],
  [/native package[^\n]*--archive/i, "Native SDK archive bypassed ScriptC"],
  [/\bbun\s+run\s+verify:release-version\b/i, "Bun executed the ScriptC-owned version gate"],
  [
    /\bbun\s+(?:run\s+)?scripts\/release-assets\.ts\b/i,
    "Bun executed the production release program",
  ],
  [/sbom-action|anchore/i, "an external SBOM step bypassed the embedded ScriptC SBOM"],
];
for (const [pattern, meaning] of forbiddenWorkflowPatterns) {
  forbidPattern("release/gate/IME workflows", workflows, pattern, meaning);
}

const nativeBuildRequirements: ReadonlyArray<readonly [string, string]> = [
  ["x86_64-pc-windows-gnu", "compile the Rust host for the Native SDK Windows ABI"],
  ['&.{ "zig", "dlltool", "-d" }', "generate the missing RuntimeObject import with Zig"],
  ["build-inputs/windows/runtimeobject.def", "bind the stable RuntimeObject export declaration"],
  ['"dbghelp"', "link Rust's DbgHelp native dependency"],
  ['"oleaut32"', "resolve the VARIANT automation functions"],
  ['"propsys"', "resolve the PROPVARIANT conversion functions"],
];
for (const [literal, meaning] of nativeBuildRequirements) {
  requireLiteral(nativeBuildFile, nativeBuild, literal, meaning);
}
requireLiteral(
  runtimeObjectFile,
  runtimeObject,
  "LIBRARY combase.dll",
  "name the library that really exports the symbol — RuntimeObject.dll is only a forwarder and is absent on trimmed Windows installs",
);
requireLiteral(
  runtimeObjectFile,
  runtimeObject,
  "RoGetActivationFactory",
  "import the one RuntimeObject symbol Rust requires",
);

const packageRequirements: ReadonlyArray<readonly [string, string]> = [
  // 八条 journal（八去处各一条）的分档住在 `scripts/native-journals.ts` 的表里，
  // 不在这里第二次声明：不开稿子的三条逐帧对指纹，开了稿子的五条走
  // `--no-verify`，因为正稿住在 host_bridge 的模块变量里而回放把主机答复直接
  // 喂给 core（M8）。详见 e2e/native/README.md。
  [
    '"e2e:journals": "bun scripts/replay-native-journals.ts"',
    "route every destination's E2E through one replay lane",
  ],
  [
    '"e2e:record": "bun scripts/record-native-journals.ts"',
    "keep the recording lane beside the replay lane",
  ],
  [
    "-Shell native -Binary apps/native/zig-out/bin/refrain.exe",
    "route IME through the Native binary",
  ],
];
for (const [literal, meaning] of packageRequirements) {
  requireLiteral(packageFile, packageJson, literal, meaning);
}

if (failures.length > 0) {
  console.error("FAIL  verify:release-workflow: Native portable release contract drifted");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:release-workflow  (Native directory -> ScriptC portable ZIP -> independent readback)",
);
