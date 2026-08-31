// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

import { createHash } from "node:crypto";

export type NativeImePlatform = "windows" | "macos";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SourceIdentity {
  readonly revision: string;
  readonly dirty: boolean;
  readonly dirtyManifestSha256: string;
}

interface ExecutableIdentity {
  readonly path: string;
  readonly reportedSha256: string;
  readonly actualSha256: string;
}

interface InputMethodIdentity {
  readonly locale: string;
  readonly identifier: string;
  readonly installed: boolean;
  readonly active: boolean;
  readonly inputSource: string;
}

interface ScreenshotEvidence {
  readonly path: string;
  readonly reportedSha256: string;
  readonly bytes: Uint8Array;
}

export interface NativeImeEvidenceInput {
  readonly schemaVersion: number;
  readonly implementation: string;
  readonly platform: NativeImePlatform;
  readonly processId: number;
  readonly source: SourceIdentity;
  readonly executable: ExecutableIdentity;
  readonly inputMethod: InputMethodIdentity;
  readonly snapshots: {
    readonly preedit: string;
    readonly movedPreedit: string;
    readonly committed: string;
    readonly cancelPreedit: string;
    readonly cancelled: string;
    readonly punctuation: string;
  };
  readonly runtimeLog: string;
  readonly screenshots: {
    readonly preedit: ScreenshotEvidence;
    readonly movedPreedit: ScreenshotEvidence;
  };
  readonly expected: {
    readonly committedText: string;
    readonly punctuation: string;
    readonly finalDocumentText: string;
  };
}

export interface NativeImeEvidenceAssessment {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly passed: boolean;
}

interface ParsedSnapshot {
  readonly ready: boolean;
  readonly publisherPid: number;
  readonly dispatchErrors: number;
  readonly gpuNonblank: boolean;
  readonly focused: boolean;
  readonly revision: number;
  readonly composition: { readonly start: number; readonly end: number } | null;
  readonly caret: Rect | null;
}

interface CandidateRecord {
  readonly platform: NativeImePlatform;
  readonly api: string;
  readonly focusedId: number;
  readonly logicalCaret: Rect;
  readonly screenRect: Rect;
  readonly candidateCount: number | null;
  readonly validPlatformResult: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const GEOMETRY_TOLERANCE = 0.51;
const MINIMUM_CANDIDATE_MOVEMENT = 8;

function numericField(fields: ReadonlyMap<string, string>, name: string): number {
  const raw = fields.get(name);
  if (raw === undefined || raw.length === 0) return Number.NaN;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function parseFields(line: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const token of line.trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator <= 0) continue;
    fields.set(token.slice(0, separator), token.slice(separator + 1));
  }
  return fields;
}

function rectFromFields(
  fields: ReadonlyMap<string, string>,
  names: readonly [string, string, string, string],
  extents: "size" | "edges",
): Rect {
  const [xName, yName, widthName, heightName] = names;
  const x = numericField(fields, xName);
  const y = numericField(fields, yName);
  const third = numericField(fields, widthName);
  const fourth = numericField(fields, heightName);
  return {
    x,
    y,
    width: extents === "size" ? third : third - x,
    height: extents === "size" ? fourth : fourth - y,
  };
}

function validRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function parseSnapshot(text: string): ParsedSnapshot {
  const header = text.match(
    /^ready=(true|false).*?dispatch_errors=(\d+).*?publisher_pid=(\d+)(?:\s|$)/m,
  );
  const revision = text.match(/protocol \d+ · session \d+ · revision (\d+) ·/);
  const widgetStart = text.search(/^\s+widget @[^\n]+ role=textbox name="RefRain manuscript"/m);
  const widgetTail = widgetStart >= 0 ? text.slice(widgetStart) : "";
  const nextWidget = widgetTail.slice(1).search(/\n\s+widget @/);
  const widget = nextWidget >= 0 ? widgetTail.slice(0, nextWidget + 1) : widgetTail;
  const composition = widget.match(/\scomposition=(\d+)\.\.(\d+)/);
  const caret = widget.match(
    /\scaret=\((-?(?:\d+(?:\.\d+)?|\.\d+)),(-?(?:\d+(?:\.\d+)?|\.\d+))\s+((?:\d+(?:\.\d+)?|\.\d+))x((?:\d+(?:\.\d+)?|\.\d+))\)/,
  );
  return {
    ready: header?.[1] === "true",
    dispatchErrors: Number(header?.[2] ?? Number.NaN),
    publisherPid: Number(header?.[3] ?? Number.NaN),
    gpuNonblank: /\bgpu_nonblank=true\b/.test(text),
    focused: /\bfocused=true\b/.test(widget),
    revision: Number(revision?.[1] ?? Number.NaN),
    composition:
      composition?.[1] !== undefined && composition[2] !== undefined
        ? { start: Number(composition[1]), end: Number(composition[2]) }
        : null,
    caret:
      caret?.[1] !== undefined &&
      caret[2] !== undefined &&
      caret[3] !== undefined &&
      caret[4] !== undefined
        ? {
            x: Number(caret[1]),
            y: Number(caret[2]),
            width: Number(caret[3]),
            height: Number(caret[4]),
          }
        : null,
  };
}

function parseCandidateRecords(log: string): readonly CandidateRecord[] {
  const records: CandidateRecord[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith("native-ime-evidence ")) continue;
    const fields = parseFields(line);
    const platform = fields.get("platform");
    if (platform === "windows") {
      const logicalCaret = rectFromFields(
        fields,
        ["logical_x", "logical_y", "logical_width", "logical_height"],
        "size",
      );
      const physical = rectFromFields(
        fields,
        ["physical_left", "physical_top", "physical_right", "physical_bottom"],
        "edges",
      );
      const observed = rectFromFields(
        fields,
        ["observed_left", "observed_top", "observed_right", "observed_bottom"],
        "edges",
      );
      const candidateCount = numericField(fields, "candidate_count");
      records.push({
        platform,
        api: fields.get("api") ?? "",
        focusedId: numericField(fields, "focused_id"),
        logicalCaret,
        screenRect: rectFromFields(
          fields,
          ["screen_left", "screen_top", "screen_right", "screen_bottom"],
          "edges",
        ),
        candidateCount,
        validPlatformResult:
          fields.get("applied") === "1" &&
          fields.get("queried") === "1" &&
          fields.get("screen_transformed") === "1" &&
          numericField(fields, "observed_style") === 128 &&
          Number.isSafeInteger(candidateCount) &&
          candidateCount > 0 &&
          rectNear(physical, observed, 0),
      });
      continue;
    }
    if (platform === "macos") {
      records.push({
        platform,
        api: fields.get("api") ?? "",
        focusedId: numericField(fields, "focused_id"),
        logicalCaret: rectFromFields(
          fields,
          ["canvas_x", "canvas_y", "canvas_width", "canvas_height"],
          "size",
        ),
        screenRect: rectFromFields(
          fields,
          ["screen_x", "screen_y", "screen_width", "screen_height"],
          "size",
        ),
        candidateCount: null,
        validPlatformResult: true,
      });
    }
  }
  return records;
}

function rectNear(left: Rect, right: Rect, tolerance = GEOMETRY_TOLERANCE): boolean {
  return (
    validRect(left) &&
    validRect(right) &&
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

function moved(left: Rect, right: Rect): boolean {
  return (
    Math.abs(left.x - right.x) >= MINIMUM_CANDIDATE_MOVEMENT ||
    Math.abs(left.y - right.y) >= MINIMUM_CANDIDATE_MOVEMENT
  );
}

function activeComposition(snapshot: ParsedSnapshot): boolean {
  return (
    snapshot.composition !== null &&
    snapshot.composition.end > snapshot.composition.start &&
    snapshot.caret !== null &&
    validRect(snapshot.caret)
  );
}

function screenshotValid(evidence: ScreenshotEvidence): boolean {
  if (!SHA256.test(evidence.reportedSha256) || evidence.bytes.byteLength < 1024) return false;
  if (PNG_SIGNATURE.some((byte, index) => evidence.bytes[index] !== byte)) return false;
  return createHash("sha256").update(evidence.bytes).digest("hex") === evidence.reportedSha256;
}

function executablePathMatches(platform: NativeImePlatform, path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const suffix =
    platform === "windows"
      ? "/apps/native/zig-out/bin/refrain.exe"
      : "/apps/native/zig-out/bin/refrain";
  return normalized.endsWith(suffix);
}

function occurrenceCount(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  return text.split(needle).length - 1;
}

export function assessNativeImeEvidence(
  input: NativeImeEvidenceInput,
): NativeImeEvidenceAssessment {
  const snapshots = {
    preedit: parseSnapshot(input.snapshots.preedit),
    movedPreedit: parseSnapshot(input.snapshots.movedPreedit),
    committed: parseSnapshot(input.snapshots.committed),
    cancelPreedit: parseSnapshot(input.snapshots.cancelPreedit),
    cancelled: parseSnapshot(input.snapshots.cancelled),
    punctuation: parseSnapshot(input.snapshots.punctuation),
  };
  const allSnapshots = Object.values(snapshots);
  const apiRecords = parseCandidateRecords(input.runtimeLog).filter(
    (record) =>
      record.platform === input.platform &&
      record.api ===
        (input.platform === "windows" ? "ImmSetCandidateWindow" : "firstRectForCharacterRange") &&
      record.focusedId > 0 &&
      validRect(record.logicalCaret) &&
      validRect(record.screenRect),
  );
  const records = apiRecords.filter((record) => record.validPlatformResult);
  const preeditCaret = snapshots.preedit.caret;
  const movedCaret = snapshots.movedPreedit.caret;
  const preeditRecord =
    preeditCaret === null
      ? undefined
      : records.find((record) => rectNear(record.logicalCaret, preeditCaret));
  const movedRecord =
    movedCaret === null
      ? undefined
      : records.find((record) => rectNear(record.logicalCaret, movedCaret));
  const finalSequence = input.expected.committedText + input.expected.punctuation;

  const checks = {
    schemaVersion: input.schemaVersion === 1,
    implementation: input.implementation === "native-rust-document-surface",
    runtimeLogShape: input.runtimeLog
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .every(
        (line) =>
          /^ts=\d+ level=info kind=event name="runtime\.event" event="[a-z0-9_]+"$/.test(line) ||
          line.startsWith(`native-ime-evidence platform=${input.platform} `),
      ),
    sourceIdentity:
      REVISION.test(input.source.revision) &&
      !input.source.dirty &&
      SHA256.test(input.source.dirtyManifestSha256),
    executableIdentity:
      executablePathMatches(input.platform, input.executable.path) &&
      SHA256.test(input.executable.reportedSha256) &&
      input.executable.reportedSha256 === input.executable.actualSha256,
    inputMethod:
      input.inputMethod.inputSource === "os" &&
      input.inputMethod.installed &&
      input.inputMethod.active &&
      input.inputMethod.identifier.length > 0 &&
      (input.platform === "windows"
        ? input.inputMethod.locale === "zh-Hans-CN"
        : input.inputMethod.locale === "ja-JP"),
    publisherIdentity:
      Number.isSafeInteger(input.processId) &&
      input.processId > 0 &&
      allSnapshots.every((snapshot) => snapshot.publisherPid === input.processId),
    snapshotReadiness: allSnapshots.every(
      (snapshot) =>
        snapshot.ready &&
        snapshot.gpuNonblank &&
        snapshot.dispatchErrors === 0 &&
        snapshot.focused &&
        Number.isSafeInteger(snapshot.revision) &&
        snapshot.revision >= 0,
    ),
    compositionLifecycle:
      activeComposition(snapshots.preedit) &&
      activeComposition(snapshots.movedPreedit) &&
      activeComposition(snapshots.cancelPreedit) &&
      snapshots.committed.composition === null &&
      snapshots.cancelled.composition === null &&
      snapshots.punctuation.composition === null &&
      snapshots.movedPreedit.revision === snapshots.preedit.revision &&
      snapshots.committed.revision > snapshots.movedPreedit.revision &&
      snapshots.cancelPreedit.revision === snapshots.committed.revision &&
      snapshots.cancelled.revision === snapshots.cancelPreedit.revision &&
      snapshots.punctuation.revision > snapshots.cancelled.revision,
    textIntegrity:
      input.expected.committedText.length > 0 &&
      input.expected.punctuation === (input.platform === "windows" ? "，。？！" : "、。？！") &&
      occurrenceCount(input.expected.finalDocumentText, finalSequence) === 1,
    platformCandidateApi: apiRecords.length >= 2,
    candidateVisibility: records.length >= 2,
    candidateGeometry: preeditRecord !== undefined && movedRecord !== undefined,
    candidateMovement:
      preeditCaret !== null &&
      movedCaret !== null &&
      preeditRecord !== undefined &&
      movedRecord !== undefined &&
      moved(preeditCaret, movedCaret) &&
      moved(preeditRecord.screenRect, movedRecord.screenRect),
    screenshotIntegrity:
      screenshotValid(input.screenshots.preedit) &&
      screenshotValid(input.screenshots.movedPreedit) &&
      input.screenshots.preedit.reportedSha256 !== input.screenshots.movedPreedit.reportedSha256,
  } as const;
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}
