#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

import { resolve } from "node:path";

/**
 * Drive the real OS input method against the shipping Native binary.
 *
 * The shell and the binary are named by the caller rather than defaulted here.
 * Naming them at the call site is what makes a CI log say which surface it
 * drove: this repository once shipped a second, embedded-browser surface, and
 * a run that silently switched between them read as the same green.
 */
const root = resolve(import.meta.dir, "../..");
const argv = process.argv.slice(2);

function option(name: string, fallback: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  return value ?? fallback;
}

const shell = option("-Shell", "native");
if (shell !== "native") {
  throw new Error(`unknown IME shell ${shell}: the product has one surface, native`);
}
const binary = option("-Binary", "apps/native/zig-out/bin/refrain.exe");

const command =
  process.platform === "win32"
    ? [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "e2e/ime/driver/drive-native-windows.ps1",
        "-Root",
        root,
        "-Shell",
        shell,
        "-Binary",
        binary,
      ]
    : process.platform === "darwin"
      ? ["bun", "e2e/ime/driver/drive-native-macos.ts"]
      : null;
if (command === null) {
  throw new Error("Native OS IME evidence requires Windows or macOS");
}
const processResult = Bun.spawnSync(command, {
  cwd: root,
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if (processResult.exitCode !== 0) process.exit(processResult.exitCode);
