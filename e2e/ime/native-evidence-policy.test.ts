// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { assessNativeImeEvidence, type NativeImeEvidenceInput } from "./native-evidence-policy.ts";

const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array.from({ length: 2048 }, (_, index) => index % 251),
]);
const MOVED_PNG = Uint8Array.from(PNG, (byte, index) => (index === 100 ? byte ^ 1 : byte));
const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function snapshot({
  pid = 4242,
  revision,
  composition,
  caret,
}: {
  readonly pid?: number;
  readonly revision: number;
  readonly composition?: string;
  readonly caret: string;
}): string {
  const compositionField = composition === undefined ? "" : ` composition=${composition}`;
  return [
    `ready=true protocol=0x096c8aa4730c11ec frame=4 commands=0 runtime_uptime_ns=10 dispatch_errors=0 dropped_trace_records=0 publisher_pid=${pid} markup_watch=off`,
    'window @w1 "RefRain" bounds=(0,0 1280x800) focused=true frame=4 commands=0',
    '  view @w1/document kind=gpu_surface role="Writing workbench" accessibility_label="RefRain document" text="Writing workbench" bounds=(0,0 1280x800) layer=0 visible=true enabled=true focused=true open=true gpu_nonblank=true',
    `    widget @w1/document#9 role=textbox name="RefRain manuscript" bounds=(16,111 1248x650) focused=true enabled=true${compositionField} caret=${caret}`,
    `    widget @w1/document#10 role=text name="protocol 5 · session 1 · revision ${revision} · 2 blocks · 31 bytes" bounds=(16,80 100x20) focused=false enabled=true`,
  ].join("\n");
}

const windowsLog = [
  "native-ime-evidence platform=windows api=ImmSetCandidateWindow focused_id=9 applied=1 queried=1 candidate_count=5 candidate_bytes=256 screen_transformed=1 logical_x=24.000 logical_y=144.000 logical_width=1.000 logical_height=20.000 physical_left=30 physical_top=180 physical_right=31 physical_bottom=205 screen_left=130 screen_top=280 screen_right=131 screen_bottom=305 observed_style=128 observed_left=30 observed_top=180 observed_right=31 observed_bottom=205",
  "native-ime-evidence platform=windows api=ImmSetCandidateWindow focused_id=9 applied=1 queried=1 candidate_count=5 candidate_bytes=256 screen_transformed=1 logical_x=24.000 logical_y=204.000 logical_width=1.000 logical_height=20.000 physical_left=30 physical_top=255 physical_right=31 physical_bottom=280 screen_left=130 screen_top=355 screen_right=131 screen_bottom=380 observed_style=128 observed_left=30 observed_top=255 observed_right=31 observed_bottom=280",
].join("\n");
const macosLog = [
  "native-ime-evidence platform=macos api=firstRectForCharacterRange focused_id=9 canvas_x=24.000 canvas_y=144.000 canvas_width=1.000 canvas_height=20.000 local_x=24.000 local_y=636.000 local_width=1.000 local_height=20.000 screen_x=130.000 screen_y=280.000 screen_width=1.000 screen_height=20.000",
  "native-ime-evidence platform=macos api=firstRectForCharacterRange focused_id=9 canvas_x=24.000 canvas_y=204.000 canvas_width=1.000 canvas_height=20.000 local_x=24.000 local_y=576.000 local_width=1.000 local_height=20.000 screen_x=130.000 screen_y=340.000 screen_width=1.000 screen_height=20.000",
].join("\n");

function validInput(): NativeImeEvidenceInput {
  return {
    schemaVersion: 1,
    implementation: "native-rust-document-surface",
    platform: "windows",
    processId: 4242,
    source: {
      revision: "a".repeat(40),
      dirty: false,
      dirtyManifestSha256: sha256("clean"),
    },
    executable: {
      path: "C:\\a\\refrain\\apps\\native\\zig-out\\bin\\refrain.exe",
      reportedSha256: sha256("native executable"),
      actualSha256: sha256("native executable"),
    },
    inputMethod: {
      locale: "zh-Hans-CN",
      identifier:
        "0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}",
      installed: true,
      active: true,
      inputSource: "os",
    },
    snapshots: {
      preedit: snapshot({ revision: 0, composition: "0..2", caret: "(24,144 1x20)" }),
      movedPreedit: snapshot({
        revision: 0,
        composition: "3..6",
        caret: "(24,204 1x20)",
      }),
      committed: snapshot({ revision: 2, caret: "(40,204 1x20)" }),
      cancelPreedit: snapshot({
        revision: 2,
        composition: "6..8",
        caret: "(40,204 1x20)",
      }),
      cancelled: snapshot({ revision: 2, caret: "(40,204 1x20)" }),
      punctuation: snapshot({ revision: 6, caret: "(80,204 1x20)" }),
    },
    runtimeLog: windowsLog,
    screenshots: {
      preedit: { path: "preedit.png", reportedSha256: sha256(PNG), bytes: PNG },
      movedPreedit: {
        path: "moved-preedit.png",
        reportedSha256: sha256(MOVED_PNG),
        bytes: MOVED_PNG,
      },
    },
    expected: {
      committedText: "你好",
      punctuation: "，。？！",
      finalDocumentText: "第一行\n第二行你好，。？！",
    },
  };
}

describe("Native IME evidence policy", () => {
  test("accepts one identity-bound OS IME run with two distinct candidate anchors", () => {
    const assessment = assessNativeImeEvidence(validInput());
    expect(assessment.passed).toBe(true);
    expect(Object.values(assessment.checks).every(Boolean)).toBe(true);
  });

  test("accepts AppKit firstRect evidence from the same shaped caret", () => {
    const input = validInput();
    const assessment = assessNativeImeEvidence({
      ...input,
      platform: "macos",
      executable: {
        ...input.executable,
        path: "/Users/runner/refrain/apps/native/zig-out/bin/refrain",
      },
      inputMethod: {
        ...input.inputMethod,
        identifier: "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese",
        locale: "ja-JP",
      },
      expected: {
        committedText: "日本語",
        punctuation: "、。？！",
        finalDocumentText: "第一行\n第二行日本語、。？！",
      },
      runtimeLog: macosLog,
    });
    expect(assessment.passed).toBe(true);
  });

  test("rejects the retired WebView implementation", () => {
    const input = validInput();
    const assessment = assessNativeImeEvidence({ ...input, implementation: "wv2" });
    expect(assessment.checks.implementation).toBe(false);
    expect(assessment.passed).toBe(false);
  });

  test("rejects a snapshot from a different publisher", () => {
    const input = validInput();
    const assessment = assessNativeImeEvidence({
      ...input,
      snapshots: {
        ...input.snapshots,
        preedit: snapshot({ pid: 7, revision: 0, composition: "0..2", caret: "(24,144 1x20)" }),
      },
    });
    expect(assessment.checks.publisherIdentity).toBe(false);
  });

  test("rejects source that did not call the platform candidate API", () => {
    const input = validInput();
    const assessment = assessNativeImeEvidence({
      ...input,
      runtimeLog: input.runtimeLog.replaceAll("ImmSetCandidateWindow", "syntheticCandidate"),
    });
    expect(assessment.checks.platformCandidateApi).toBe(false);
  });

  test("rejects a Windows IME record with no OS candidate list", () => {
    const input = validInput();
    const assessment = assessNativeImeEvidence({
      ...input,
      runtimeLog: input.runtimeLog.replaceAll("candidate_count=5", "candidate_count=0"),
    });
    expect(assessment.checks.platformCandidateApi).toBe(true);
    expect(assessment.checks.candidateVisibility).toBe(false);
    expect(assessment.passed).toBe(false);
  });

  test("rejects unrelated runtime stderr beside candidate evidence", () => {
    const input = validInput();
    const assessment = assessNativeImeEvidence({
      ...input,
      runtimeLog: `${input.runtimeLog}\nunexpected warning`,
    });
    expect(assessment.checks.runtimeLogShape).toBe(false);
  });

  test("rejects a candidate anchor that did not move with the shaped caret", () => {
    const input = validInput();
    const assessment = assessNativeImeEvidence({
      ...input,
      snapshots: {
        ...input.snapshots,
        movedPreedit: snapshot({ revision: 1, composition: "3..6", caret: "(24,144 1x20)" }),
      },
    });
    expect(assessment.checks.candidateMovement).toBe(false);
  });

  test("rejects a one-byte screenshot mutation", () => {
    const input = validInput();
    const mutated = Uint8Array.from(input.screenshots.preedit.bytes);
    mutated[100] = (mutated[100] ?? 0) ^ 1;
    const assessment = assessNativeImeEvidence({
      ...input,
      screenshots: {
        ...input.screenshots,
        preedit: { ...input.screenshots.preedit, bytes: mutated },
      },
    });
    expect(assessment.checks.screenshotIntegrity).toBe(false);
  });
});
