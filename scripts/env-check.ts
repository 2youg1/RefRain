#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * Plan v0.2.3 §4.1: one command that says whether this machine can build, and
 * prints the fix when it cannot.
 *
 * The failure this exists to stop is not "a tool is missing". It is that a
 * missing tool arrives disguised. Without REFRAIN_ZIG, cargo says
 * ``linker `cc` not found``; without REFRAIN_SYSROOT it panics inside the dbus
 * build script. Both read as a missing system package, so the next hour goes to
 * installing something that is already there. A full gate run was lost to this
 * once. Each probe below therefore reports the *cause* it detected and a line
 * the reader can paste, never a raw tool error.
 *
 * This file probes; it does not configure. scripts/toolchain-env.sh owns the
 * environment, and a second copy of that knowledge here would drift from it.
 * What is checked is the observable result of sourcing it.
 */

import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

type Health = "ok" | "missing" | "not-applicable";

interface Probe {
  readonly name: string;
  readonly health: Health;
  /** What was observed. Present whether the probe passed or failed. */
  readonly detail: string;
  /** A line the reader can paste. Required whenever health is "missing". */
  readonly fix?: string;
}

const host = platform();
const isLinux = host === "linux";
const isMac = host === "darwin";
const isWindows = host === "win32";

function run(command: string, args: readonly string[]): string | null {
  // A command that is not on PATH makes Bun.spawnSync throw rather than return
  // an unsuccessful result. Uncaught, this probe would die printing its own
  // source at the first absent tool — which is exactly the machine it exists to
  // diagnose. Measured: with cargo off PATH, the script crashed instead of
  // reporting "cargo is not on PATH".
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!result.success) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

function which(command: string): string | null {
  const finder = isWindows ? "where" : "which";
  const found = run(finder, [command]);
  return found ? (found.split(/\r?\n/)[0] ?? null) : null;
}

const probes: Probe[] = [];

// ---------------------------------------------------------------- toolchains

const cargo = run("cargo", ["--version"]);
probes.push(
  cargo
    ? { name: "cargo", health: "ok", detail: cargo }
    : {
        name: "cargo",
        health: "missing",
        detail: "cargo is not on PATH",
        fix: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      },
);

const bun = run("bun", ["--version"]);
probes.push(
  bun
    ? { name: "bun", health: "ok", detail: `bun ${bun}` }
    : {
        name: "bun",
        health: "missing",
        detail: "bun is not on PATH",
        fix: "curl -fsSL https://bun.sh/install | bash",
      },
);

// Node is not the runtime for this repo, but scripts/make.sh runs the ledger
// check under Node to exercise the branch bun never takes. A machine without it
// silently skips that coverage.
const node = run("node", ["--version"]);
probes.push(
  node
    ? { name: "node", health: "ok", detail: `node ${node}` }
    : {
        name: "node",
        health: "missing",
        detail: "node is absent; the Node branch of the SQLite adapter is unverified here",
        fix: "install Node 24 (nvm install 24) — CI uses actions/setup-node",
      },
);

// -------------------------------------------------------------------- linker

// A linker is the one thing rustup will not tell you about: it reports success
// while leaving the machine unable to link a binary, and a crate that produces
// only rlibs still builds, so a naive probe comes back green.
const zigDir = process.env.REFRAIN_ZIG;
const systemCc = isWindows ? which("link") : which("cc");

if (systemCc) {
  probes.push({
    name: "linker",
    health: "ok",
    detail: `system linker at ${systemCc}`,
  });
} else if (zigDir && existsSync(join(zigDir, "zigcc"))) {
  probes.push({
    name: "linker",
    health: "ok",
    detail: `zig shim at ${join(zigDir, "zigcc")}`,
  });
} else if (zigDir) {
  probes.push({
    name: "linker",
    health: "missing",
    detail: `REFRAIN_ZIG is ${zigDir} but no zigcc shim is in it`,
    fix: `printf '#!/bin/sh\\nexec <zig-binary> cc "$@"\\n' > ${join(zigDir, "zigcc")} && chmod +x ${join(zigDir, "zigcc")}`,
  });
} else {
  probes.push({
    name: "linker",
    health: "missing",
    detail:
      "no system cc and REFRAIN_ZIG is unset — cargo will say `linker \\`cc\\` not found`, which is not a missing crate",
    fix: "install a C toolchain, or unpack zig and: export REFRAIN_ZIG=/path/to/zig-dir && source scripts/toolchain-env.sh",
  });
}

// ------------------------------------------------------------------- sysroot

// Tauri's Linux build links gtk, webkit2gtk, libsoup and dbus. macOS and
// Windows carry their own webview, so this probe does not apply there — and
// saying so is the point: a "missing" line on a Mac would send the reader
// hunting for a package that does not exist for their platform.
if (isLinux) {
  const sysroot =
    process.env.REFRAIN_SYSROOT ?? join(process.env.HOME ?? "", ".local/share/tauri-sysroot");
  const pkgconfig = join(sysroot, "usr/lib/x86_64-linux-gnu/pkgconfig");

  // Distinguish "gtk is absent" from "pkg-config itself cannot start". The
  // second returns 127 because the sysroot's pkg-config links libpkgconf from
  // the same tree, and an early version of this probe read that as a plain
  // false — reporting the sysroot healthy on a shell that could not run a
  // single tool from it. Measured on this machine: without LD_LIBRARY_PATH,
  // `pkg-config --exists gtk+-3.0` exits 127 with
  // "libpkgconf.so.3: cannot open shared object file".
  const pkgProbe = (() => {
    try {
      const result = Bun.spawnSync(["pkg-config", "--exists", "gtk+-3.0"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(result.stderr);
      if (result.exitCode === 127 || /shared libraries/.test(stderr)) {
        return { kind: "unusable" as const, stderr: stderr.trim() };
      }
      return { kind: result.success ? ("yes" as const) : ("no" as const) };
    } catch {
      return { kind: "absent" as const };
    }
  })();

  if (pkgProbe.kind === "unusable") {
    probes.push({
      name: "gtk/webkit",
      health: "missing",
      detail: `pkg-config cannot start: ${pkgProbe.stderr.split("\n")[0]}`,
      fix: `export LD_LIBRARY_PATH=${sysroot}/usr/lib/x86_64-linux-gnu:${sysroot}/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH`,
    });
  } else if (pkgProbe.kind === "yes") {
    probes.push({
      name: "gtk/webkit",
      health: "ok",
      detail: "pkg-config resolves gtk+-3.0",
    });
  } else if (existsSync(pkgconfig)) {
    probes.push({
      name: "gtk/webkit",
      health: "missing",
      detail: `a sysroot exists at ${sysroot} but pkg-config does not resolve gtk+-3.0 from it`,
      fix: "source scripts/toolchain-env.sh   (it exports PKG_CONFIG_PATH and PKG_CONFIG_SYSROOT_DIR; PATH alone is not enough, because a build script inherits the variable, not the shell's lookup)",
    });
  } else {
    probes.push({
      name: "gtk/webkit",
      health: "missing",
      detail: `no gtk and no sysroot at ${sysroot} — cargo reports this as an explicit panic inside the dbus build script, which reads like a missing package`,
      fix: 'export REFRAIN_SYSROOT=/path/to/sysroot && source scripts/toolchain-env.sh   (unpack without root: dpkg-deb -x pkg.deb "$REFRAIN_SYSROOT")',
    });
  }
} else {
  probes.push({
    name: "gtk/webkit",
    health: "not-applicable",
    detail: isMac
      ? "macOS links WKWebView from the system"
      : "Windows links WebView2 from the system",
  });
}

// ------------------------------------------------------- headless Chromium

// see-app.ts renders the real frontend in Chromium, which is the same engine
// WebView2 embeds. When its shared libraries are absent the browser exits 127
// and every screenshot scenario fails at once, with no indication that the
// cause is a loader path rather than the page.
const chromiumHome = join(
  process.env.HOME ?? "",
  isMac ? "Library/Caches/ms-playwright" : ".cache/ms-playwright",
);
const chromiumInstalled = isWindows
  ? existsSync(join(process.env.LOCALAPPDATA ?? "", "ms-playwright"))
  : existsSync(chromiumHome);
probes.push(
  chromiumInstalled
    ? {
        name: "playwright chromium",
        health: "ok",
        detail: `browsers under ${chromiumHome}`,
      }
    : {
        name: "playwright chromium",
        health: "missing",
        detail: "no Playwright browsers; the render gates and see-app cannot run",
        fix: "bun x playwright install chromium",
      },
);

// ------------------------------------------------------------ bundle targets

// 步骤 10 之后打包由 Native SDK 的 `native build` 负责，三平台目标写在
// `app.zon` 的 `platforms` 里，不再有 tauri.conf.json。
const appZon = await Bun.file("apps/native/app.zon").text();
const declared = [...appZon.matchAll(/"(macos|windows|linux)"/g)].map((m) => m[1]);
probes.push(
  declared.length === 3
    ? {
        name: "bundle targets",
        health: "ok",
        detail: `app.zon declares [${declared.join(", ")}]`,
      }
    : {
        name: "bundle targets",
        health: "missing",
        detail: `app.zon declares [${declared.join(", ")}]`,
        fix: 'set .platforms = .{ "macos", "windows", "linux" } in apps/native/app.zon',
      },
);

// ------------------------------------------------------------------- report

const width = Math.max(...probes.map((probe) => probe.name.length));
const missing = probes.filter((probe) => probe.health === "missing");

for (const probe of probes) {
  const mark = probe.health === "ok" ? "ok " : probe.health === "missing" ? "MISS" : "n/a ";
  console.log(`${mark}  ${probe.name.padEnd(width)}  ${probe.detail}`);
}

if (missing.length > 0) {
  console.log("");
  console.log(`${missing.length} of ${probes.length} checks need action:`);
  for (const probe of missing) {
    console.log("");
    console.log(`  ${probe.name}`);
    console.log(`    ${probe.fix}`);
  }
  process.exit(1);
}

console.log("");
console.log(`env:check  all ${probes.length} checks pass on ${host}`);
