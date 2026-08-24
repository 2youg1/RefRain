#!/usr/bin/env bun
import { readFileSync } from "node:fs";

interface Contract {
  readonly path: string;
  readonly required: readonly string[];
  readonly forbidden?: readonly string[];
}

const contracts: readonly Contract[] = [
  {
    path: "patches/@native-sdk%2Fcli@0.10.0.patch",
    required: [
      "diff --git a/src/automation/snapshot.zig b/src/automation/snapshot.zig",
      "text_caret_bounds",
      "update_text_input_geometry",
      "ImmSetCandidateWindow(imc, &candidate)",
      "const bool queried = ImmGetCandidateWindow(imc, 0, &observed) != FALSE;",
      "ImmGetCandidateListW(imc, 0, nullptr, 0)",
      "candidate_count=%lu",
      "api=firstRectForCharacterRange",
      "NATIVE_SDK_IME_EVIDENCE",
      "caret=({d},{d} {d}x{d})",
    ],
    forbidden: ["syntheticCandidate", "characterCountRatio"],
  },
  {
    path: ".github/workflows/ime-gate.yml",
    required: [
      "windows-native-ime:",
      "-Dautomation=true -Doptimize=ReleaseFast",
      "drive-native-windows.ps1",
      "assert-native.ts",
      "native-ime-windows",
    ],
    // The macOS job is not required here. It was a job pinned to
    // `[self-hosted, macOS, refrain-ime]`, and no such runner is registered, so
    // it never ran and never could — a gate that cannot run proves nothing. The
    // macOS driver keeps its own contract below, and `e2e:ime:macos` keeps it
    // reachable from a machine that has the input source.
    forbidden: [
      "tauri build",
      "-Shell wv2",
      "apps/desktop",
      "runs-on: [self-hosted, macOS, refrain-ime]",
    ],
  },
  {
    path: "package.json",
    required: [
      '"e2e:ime": "bun e2e/ime/run-native.ts',
      '"e2e:ime:macos": "bun e2e/ime/driver/drive-native-macos.ts"',
    ],
  },
  {
    path: "e2e/ime/run-native.ts",
    required: ["drive-native-windows.ps1", "drive-native-macos.ts", "process.platform"],
    forbidden: ["drive.ps1", "wv2"],
  },
  {
    path: "e2e/ime/driver/drive-native-windows.ps1",
    required: [
      "Start-Process $Executable",
      "NATIVE_SDK_IME_EVIDENCE",
      "Set-WinDefaultInputMethodOverride",
      "Invoke-NativeAutomation",
      // The runtime publishes its automation channel under its own working
      // directory, so both the app and every `native automate` call must be
      // started in apps/native. Launched from the repository root this lane
      // read a previous run's snapshot for thirty seconds and reported a
      // timeout (Memo D45); `Push-Location` used to carry half of this.
      "-WorkingDirectory $NativeDir",
      // Naming the keyboard layout and reading the conversion mode back, in
      // place of blind Shift / Ctrl+Space toggles that flip a mode which was
      // already correct (Memo D47).
      "WM_INPUTLANGCHANGEREQUEST",
      "Set-ImeChineseMode",
      "Capture-Screen",
      "capture-native-identity.ts",
      "assert-native.ts",
    ],
    // `-Shell wv2` is the shape that matters: a second surface returning. The
    // parameter itself is required by verify:release-workflow so a CI log says
    // which surface it drove, and `ValidateSet` admits only `native`.
    forbidden: ["msedgewebview2", "tauri", "-Shell wv2", "--project"],
  },
  {
    path: "e2e/ime/driver/drive-native-macos.ts",
    required: [
      "Bun.spawn([EXECUTABLE]",
      "NATIVE_SDK_IME_EVIDENCE",
      "System Events",
      "screencapture",
      "Kotoeri.RomajiTyping.Japanese",
      "capture-native-identity.ts",
      "assert-native.ts",
    ],
    forbidden: ["WebView", "tauri", "synthetic", "--project"],
  },
  {
    path: "e2e/ime/assert-native.ts",
    required: [
      "assertSourceExecutableIdentityUnchanged",
      "collectSourceExecutableIdentity",
      "Native IME evidence platform",
      "assessNativeImeEvidence",
      "realPlatformSigned",
    ],
  },
  {
    path: "e2e/ime/native-evidence-policy.ts",
    required: [
      '"native-rust-document-surface"',
      '"ImmSetCandidateWindow"',
      '"firstRectForCharacterRange"',
      "publisherIdentity",
      "compositionLifecycle",
      "candidateVisibility",
      "candidateMovement",
      "screenshotIntegrity",
    ],
    forbidden: ["passed: true", "as any"],
  },
];

const failures: string[] = [];
for (const contract of contracts) {
  const text = readFileSync(contract.path, "utf8");
  for (const token of contract.required) {
    if (!text.includes(token)) failures.push(`${contract.path} lacks ${token}`);
  }
  for (const token of contract.forbidden ?? []) {
    if (text.includes(token)) failures.push(`${contract.path} contains forbidden ${token}`);
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:native-ime");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}
console.log(
  `PASS  verify:native-ime  (${contracts.length} Native patch, platform driver, and evidence contracts)`,
);
