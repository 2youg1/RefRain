#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * INV-1 asked of the artifact instead of of the sources — and the honest answer.
 *
 * `verify:no-network` reads two things nobody ships: the code we wrote, and the
 * dependency graph we resolved. This gate reads the object an author actually
 * runs. The loader binds every imported symbol before `main`, so a network call
 * that entered the binary through any path is a name in its import table.
 *
 * **What the first reading found, and why this gate is a register rather than a
 * ban.** The shipped binary binds twenty-five of them today — the whole Winsock
 * surface plus three WinHTTP entries. None comes from RefRain. `ws2_32` is
 * linked unconditionally by the SDK's app build (`build/app.zig`) and by this
 * app's `build.zig`; WinHTTP arrives with Media Foundation, which the SDK links
 * for video. So a gate that simply banned these names could never be green, and
 * a gate whose allowance is "everything currently present" asserts nothing about
 * the future.
 *
 * The register solves both. It names exactly what is bound today and fails on
 * **any** change in either direction, the same shape `verify:unsafe-surface`
 * uses for the `unsafe` count: a new name means a new network capability entered
 * the binary and someone must say why; a name that disappears means the register
 * grew stale and must be tightened, so it can never become a floor that hides a
 * later regression.
 *
 * **What this proves and what it does not.** It proves the artifact's network
 * surface is exactly the one the platform libraries brought and no larger. It
 * does not prove nothing calls them — the source scan and the graph scan answer
 * that, and the three are complementary. Recording the discrepancy is the point:
 * INV-1 says "the application process opens no sockets", and until this gate
 * existed nobody could see that the process it ships is linked against the
 * machinery for doing so.
 *
 * Injection proof that this gate bites: add a crate or a Zig call that reaches
 * a symbol outside the register, rebuild, and the gate names it.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { nativeExecutablePath } from "./native-runtime-process.ts";

const nativeDir = join(import.meta.dir, "../apps/native");
const binary = nativeExecutablePath(nativeDir);

/**
 * Every network symbol worth asking about, on the platforms this ships to.
 *
 * A superset of what is bound: the ones absent are the assertion, and listing
 * them is what makes their absence checked rather than assumed.
 */
const NETWORK_SYMBOLS = [
  // Winsock: the connection itself.
  "connect",
  "WSAConnect",
  "socket",
  "WSASocketW",
  "closesocket",
  "bind",
  "listen",
  "accept",
  "shutdown",
  "select",
  "ioctlsocket",
  "setsockopt",
  "getsockopt",
  "WSAStartup",
  "WSACleanup",
  "WSAIoctl",
  // Winsock: moving bytes.
  "send",
  "recv",
  "sendto",
  "recvfrom",
  "WSASend",
  "WSARecv",
  // Name resolution: you cannot reach a host without it.
  "getaddrinfo",
  "freeaddrinfo",
  "GetAddrInfoW",
  "gethostbyname",
  // Application-level stacks.
  "WinHttpOpen",
  "WinHttpConnect",
  "WinHttpSendRequest",
  "InternetOpenA",
  "InternetConnectA",
  // POSIX equivalents, for the platforms that are not Windows.
  "getnameinfo",
  "socketpair",
] as const;

/**
 * The register: exactly what the shipped binary binds today, and who brought it.
 *
 * Not an allowance. A name here is a fact about the platform libraries the SDK
 * links, recorded so that a twenty-sixth name has to be explained.
 */
const REGISTERED: Readonly<Record<string, string>> = {
  // `ws2_32` is linked unconditionally: `apps/native/build.zig` names it, and
  // so does the SDK's own app build. Nothing in RefRain calls into it.
  connect: "ws2_32, linked unconditionally by the app build",
  socket: "ws2_32, linked unconditionally by the app build",
  WSASocketW: "ws2_32, linked unconditionally by the app build",
  closesocket: "ws2_32, linked unconditionally by the app build",
  bind: "ws2_32, linked unconditionally by the app build",
  listen: "ws2_32, linked unconditionally by the app build",
  accept: "ws2_32, linked unconditionally by the app build",
  shutdown: "ws2_32, linked unconditionally by the app build",
  select: "ws2_32, linked unconditionally by the app build",
  ioctlsocket: "ws2_32, linked unconditionally by the app build",
  setsockopt: "ws2_32, linked unconditionally by the app build",
  getsockopt: "ws2_32, linked unconditionally by the app build",
  WSAStartup: "ws2_32, linked unconditionally by the app build",
  WSACleanup: "ws2_32, linked unconditionally by the app build",
  send: "ws2_32, linked unconditionally by the app build",
  recv: "ws2_32, linked unconditionally by the app build",
  sendto: "ws2_32, linked unconditionally by the app build",
  recvfrom: "ws2_32, linked unconditionally by the app build",
  WSASend: "ws2_32, linked unconditionally by the app build",
  WSARecv: "ws2_32, linked unconditionally by the app build",
  getaddrinfo: "ws2_32, linked unconditionally by the app build",
  freeaddrinfo: "ws2_32, linked unconditionally by the app build",
  // WinHTTP arrives with Media Foundation, which the SDK links for video.
  WinHttpOpen: "WINHTTP.dll, pulled in by Media Foundation (SDK video)",
  WinHttpConnect: "WINHTTP.dll, pulled in by Media Foundation (SDK video)",
  WinHttpSendRequest: "WINHTTP.dll, pulled in by Media Foundation (SDK video)",
};

let size: number;
try {
  size = statSync(binary).size;
} catch {
  console.error(`FAIL  verify:no-network-imports: ${binary} is not built`);
  console.error("      build it first: bun run --cwd apps/native build");
  process.exit(1);
}
if (size === 0) {
  console.error(`FAIL  verify:no-network-imports: ${binary} is empty`);
  process.exit(1);
}

const bytes = new Uint8Array(await Bun.file(binary).arrayBuffer());

/**
 * Is `needle` present as a NUL-terminated symbol name?
 *
 * The terminator is what keeps `connect` from matching inside `connected`, and
 * requiring a non-identifier byte before it keeps it from matching the tail of
 * `WSAConnect`. Import names are stored exactly this way in both PE and ELF, so
 * a byte search reads them without a parser for two formats.
 */
function importsSymbol(needle: string): boolean {
  const pattern = new TextEncoder().encode(needle);
  const identifier = /[A-Za-z0-9_]/;
  outer: for (let start = 0; start + pattern.length < bytes.length; start += 1) {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (bytes[start + offset] !== pattern[offset]) continue outer;
    }
    if (bytes[start + pattern.length] !== 0) continue;
    const before = start === 0 ? 0 : (bytes[start - 1] ?? 0);
    if (identifier.test(String.fromCharCode(before))) continue;
    return true;
  }
  return false;
}

const bound: ReadonlySet<string> = new Set<string>(NETWORK_SYMBOLS.filter(importsSymbol));
const failures: string[] = [];
for (const symbol of bound) {
  if (REGISTERED[symbol] === undefined) {
    failures.push(
      `${symbol} is bound and is not registered — a new network capability entered the binary`,
    );
  }
}
for (const symbol of Object.keys(REGISTERED)) {
  if (!bound.has(symbol)) {
    failures.push(
      `${symbol} is registered but no longer bound — tighten the register instead of leaving it a floor`,
    );
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:no-network-imports");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:no-network-imports  (${(size / 1024 / 1024).toFixed(1)} MB binary binds exactly the ${bound.size} registered platform symbols, none of the other ${NETWORK_SYMBOLS.length - bound.size})`,
);
process.exit(0);
