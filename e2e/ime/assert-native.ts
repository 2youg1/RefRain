#!/usr/bin/env bun
import { resolve, sep } from "node:path";

import {
  assertSourceExecutableIdentityUnchanged,
  collectSourceExecutableIdentity,
  type SourceExecutableIdentity,
} from "../../scripts/native-document-evidence-identity.ts";
import {
  assessNativeImeEvidence,
  type NativeImeEvidenceInput,
  type NativeImePlatform,
} from "./native-evidence-policy.ts";

type SnapshotName =
  | "preedit"
  | "movedPreedit"
  | "committed"
  | "cancelPreedit"
  | "cancelled"
  | "punctuation";
type ScreenshotName = "preedit" | "movedPreedit";

interface RunManifest {
  readonly schemaVersion: number;
  readonly implementation: string;
  readonly platform: NativeImePlatform;
  readonly processId: number;
  readonly executablePath: string;
  readonly identityPath: string;
  readonly runtimeLogPath: string;
  readonly finalDocumentPath: string;
  readonly resultPath: string;
  readonly snapshots: Readonly<Record<SnapshotName, string>>;
  readonly screenshots: Readonly<
    Record<ScreenshotName, { readonly path: string; readonly sha256: string }>
  >;
  readonly inputMethod: {
    readonly locale: string;
    readonly identifier: string;
    readonly installed: boolean;
    readonly active: boolean;
    readonly inputSource: string;
  };
  readonly expected: {
    readonly committedText: string;
    readonly punctuation: string;
  };
}

const SNAPSHOT_NAMES: readonly SnapshotName[] = [
  "preedit",
  "movedPreedit",
  "committed",
  "cancelPreedit",
  "cancelled",
  "punctuation",
];
const SCREENSHOT_NAMES: readonly ScreenshotName[] = ["preedit", "movedPreedit"];

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
  return field;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const field = value[name];
  if (typeof field !== "boolean") throw new Error(`${name} must be a boolean`);
  return field;
}

function integerField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return field;
}

function parseManifest(value: unknown): RunManifest {
  const root = record(value, "manifest");
  const platform = stringField(root, "platform");
  if (platform !== "windows" && platform !== "macos") {
    throw new Error(`platform must be windows or macos, received ${platform}`);
  }
  const snapshotRecord = record(root.snapshots, "snapshots");
  const snapshots = Object.fromEntries(
    SNAPSHOT_NAMES.map((name) => [name, stringField(snapshotRecord, name)]),
  ) as Record<SnapshotName, string>;
  const screenshotRecord = record(root.screenshots, "screenshots");
  const screenshots = Object.fromEntries(
    SCREENSHOT_NAMES.map((name) => {
      const screenshot = record(screenshotRecord[name], `screenshots.${name}`);
      return [
        name,
        {
          path: stringField(screenshot, "path"),
          sha256: stringField(screenshot, "sha256"),
        },
      ];
    }),
  ) as Record<ScreenshotName, { readonly path: string; readonly sha256: string }>;
  const inputMethod = record(root.inputMethod, "inputMethod");
  const expected = record(root.expected, "expected");
  return {
    schemaVersion: integerField(root, "schemaVersion"),
    implementation: stringField(root, "implementation"),
    platform,
    processId: integerField(root, "processId"),
    executablePath: stringField(root, "executablePath"),
    identityPath: stringField(root, "identityPath"),
    runtimeLogPath: stringField(root, "runtimeLogPath"),
    finalDocumentPath: stringField(root, "finalDocumentPath"),
    resultPath: stringField(root, "resultPath"),
    snapshots,
    screenshots,
    inputMethod: {
      locale: stringField(inputMethod, "locale"),
      identifier: stringField(inputMethod, "identifier"),
      installed: booleanField(inputMethod, "installed"),
      active: booleanField(inputMethod, "active"),
      inputSource: stringField(inputMethod, "inputSource"),
    },
    expected: {
      committedText: stringField(expected, "committedText"),
      punctuation: stringField(expected, "punctuation"),
    },
  };
}

function parseIdentity(value: unknown): SourceExecutableIdentity {
  const identity = record(value, "identity");
  return {
    sourceRevision: stringField(identity, "sourceRevision"),
    sourceDirty: booleanField(identity, "sourceDirty"),
    dirtyManifestSha256: stringField(identity, "dirtyManifestSha256"),
    executableSha256: stringField(identity, "executableSha256"),
  };
}

function evidencePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error(`evidence path leaves repository root: ${path}`);
  }
  return absolute;
}

async function text(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`missing evidence file: ${path}`);
  return file.text();
}

async function bytes(path: string): Promise<Uint8Array> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`missing evidence file: ${path}`);
  return new Uint8Array(await file.arrayBuffer());
}

const root = resolve(option("--root"));
const manifestPath = evidencePath(root, option("--manifest"));
const manifest = parseManifest(JSON.parse(await text(manifestPath)) as unknown);
const runtimePlatform: NativeImePlatform | null =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : null;
if (runtimePlatform !== manifest.platform) {
  throw new Error(
    `Native IME evidence platform ${manifest.platform} cannot be signed on ${process.platform}`,
  );
}

const executablePath = evidencePath(root, manifest.executablePath);
const before = parseIdentity(
  JSON.parse(await text(evidencePath(root, manifest.identityPath))) as unknown,
);
const after = await collectSourceExecutableIdentity(root, executablePath);
assertSourceExecutableIdentityUnchanged(before, after);

const snapshots = Object.fromEntries(
  await Promise.all(
    SNAPSHOT_NAMES.map(async (name) => [
      name,
      await text(evidencePath(root, manifest.snapshots[name])),
    ]),
  ),
) as Record<SnapshotName, string>;
const screenshots = Object.fromEntries(
  await Promise.all(
    SCREENSHOT_NAMES.map(async (name) => [
      name,
      {
        path: manifest.screenshots[name].path,
        reportedSha256: manifest.screenshots[name].sha256,
        bytes: await bytes(evidencePath(root, manifest.screenshots[name].path)),
      },
    ]),
  ),
) as NativeImeEvidenceInput["screenshots"];
const finalDocumentText = await text(evidencePath(root, manifest.finalDocumentPath));
const input: NativeImeEvidenceInput = {
  schemaVersion: manifest.schemaVersion,
  implementation: manifest.implementation,
  platform: manifest.platform,
  processId: manifest.processId,
  source: {
    revision: before.sourceRevision,
    dirty: before.sourceDirty,
    dirtyManifestSha256: before.dirtyManifestSha256,
  },
  executable: {
    path: executablePath,
    reportedSha256: before.executableSha256,
    actualSha256: after.executableSha256,
  },
  inputMethod: manifest.inputMethod,
  snapshots,
  runtimeLog: await text(evidencePath(root, manifest.runtimeLogPath)),
  screenshots,
  expected: {
    ...manifest.expected,
    finalDocumentText,
  },
};
const assessment = assessNativeImeEvidence(input);
const result = {
  schemaVersion: 1,
  implementation: manifest.implementation,
  platform: manifest.platform,
  sourceExecutableIdentity: before,
  processId: manifest.processId,
  inputMethod: manifest.inputMethod,
  artifacts: {
    snapshots: manifest.snapshots,
    screenshots: manifest.screenshots,
    runtimeLog: manifest.runtimeLogPath,
    finalDocument: manifest.finalDocumentPath,
  },
  checks: assessment.checks,
  passed: assessment.passed,
  realPlatformSigned: assessment.passed,
};
const resultPath = evidencePath(root, manifest.resultPath);
await Bun.write(resultPath, `${JSON.stringify(result, null, 2)}\n`);
if (!assessment.passed) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));
