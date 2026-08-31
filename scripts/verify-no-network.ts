#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * INV-1: the application process makes no outbound request.
 *
 * No model call, no API key, no telemetry, no auto-update. A model runs inside
 * the author's own harness, launched as a child process — that process may
 * reach the network, and saying otherwise would be the dishonest version of
 * this promise (SPEC 5.1).
 *
 * Injection proof that this gate bites: add `fetch("https://example.com")` to
 * any component or Rust crate and this exits 1 naming the file and line.
 *
 * 高亮曾经是这条承诺最薄的一处：Shiki 的便利入口
 * （`import { codeToHtml } from "shiki"`）按需加载语法与主题，最坏情况从 CDN
 * 取，而渲染结果里看不出差别，只在生产环境表现为一次请求。
 *
 * **这个风险已经消失，不是被守住了**：Native SDK 的 `code` 部件自带 17 门
 * 语法的高亮器（`primitives/canvas/code.zig`），编译进二进制，没有语法包
 * 要加载。Shiki 三个包因此在步骤 11 退出 dependencies——不是「暂时没有
 * 消费者」，是这项能力换了实现，永远不会接回来。
 *
 * **`nomnoml` 已退出**：图是 v0.2.4 已发布的能力，但 nomnoml 是 JS 库，
 * 而交付的二进制里没有 JavaScript 运行时——它没有消费路径，已随步骤 11
 * 退出 dependencies。原生表面接上图的那一天，实现只能是原生的；它曾经
 * 能不写 `fetch` 就出网（动态 import 拉运行时资源），届时出网面按那个
 * 实现重新评，与这个已删除的库无关。
 *
 * **`pdfjs-dist` 已退出**：它解决的是「把 PDF 页面画出来」，而 RefRain 里
 * 一份 PDF 只当被引用的资料——作者要的是找到那句话并回得到原件，不是版式。
 * 抽取（`lopdf`，Rust 侧）现在带页锚，引文因此说得出页码；画页面这件事
 * 没有消费者，留一个要浏览器引擎的依赖只会让这道门禁一直为它写例外。
 */

import { readFileSync } from "node:fs";

import { report, scan } from "./gate-lib.ts";

const OUTBOUND =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(|\breqwest::|\bureq::|\bhyper::Client|https?:\/\/(?!localhost|127\.0\.0\.1|schema\.tauri\.app|biomejs\.dev)/;

const APPLICATION_SOURCES = [
  "apps/native/src/**/*.ts",
  "apps/native/host/src/**/*.rs",
  "crates/**/src/**/*.rs",
];

/**
 * `bridge.ts` is where the renderer touches the host, and the one file allowed
 * to name a request primitive. Its single use is `refrain-artifact://`, a
 * protocol this process registers and answers itself: not one byte leaves the
 * machine (F-10 / D5).
 *
 * This is a scope rule, not an allowance. Nothing here says a particular line
 * is acceptable — the file is excluded from the scan and then asserted
 * separately below, which is why an outbound request cannot hide beside the
 * permitted one. An earlier attempt did allow a line, and
 * `fetch("https://…") || fetch("refrain-artifact://…")` walked straight past it.
 */
// 步骤 10 之前这是渲染层碰宿主的那个文件，也是唯一准许出现请求原语的地方
// （它只用本进程自答的 `refrain-artifact://`）。Native 之后跨界只经一个
// C ABI 入口与生成协议，两者都不认识请求原语，所以这条例外收得更紧。
const BRIDGE = "apps/native/src/generated/protocol.ts";

/**
 * A Rust unit test lives inside the file it tests, under `#[cfg(test)]`, and a
 * line-breaking test needs a URL **as text** — that is the input whose breaking
 * is under test, not a request.
 *
 * Same shape as the bridge rule: nothing here allows a line. The test module is
 * excluded from the scan and then asserted separately below with a *stricter*
 * requirement than the scan applies — it may contain URL literals but not one
 * request primitive. So an outbound call cannot hide beside a permitted URL,
 * and a URL above the test module still fails the scan.
 */
function testModuleStart(source: string): number {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => /^\s*#\[cfg\(test\)\]\s*$/.test(line));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index + 1;
}

/** Request primitives only — no URL literal. A test may name a URL; it may not call one. */
const REQUEST_PRIMITIVE =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(|\breqwest::|\bureq::|\bhyper::Client/;

const testModuleStarts = new Map<string, number>();
const result = scan(APPLICATION_SOURCES, OUTBOUND, {
  // A comment explaining the rule is not a violation of it. A URL inside a
  // doc comment is how the reason gets recorded.
  ignoreLine: (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line),
  skipFile: (file) => file === BRIDGE,
});

// Drop findings that sit inside a Rust `#[cfg(test)]` module, then hold every
// such module to the stricter rule below. Reading the boundary from the source
// keeps this a scope rule: it cannot be claimed by a comment.
const outsideTests = result.findings.filter((finding) => {
  if (!finding.file.endsWith(".rs")) return true;
  let start = testModuleStarts.get(finding.file);
  if (start === undefined) {
    start = testModuleStart(readFileSync(finding.file, "utf8"));
    testModuleStarts.set(finding.file, start);
  }
  return finding.line < start;
});

// The stricter assertion: a test module may name a URL, but it may not hold a
// single request primitive. `fetch("https://…")` inside `#[cfg(test)]` fails
// here even though the scan above no longer sees it.
for (const [file, start] of testModuleStarts) {
  if (start === Number.MAX_SAFE_INTEGER) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(\/\/|\/\*|\*|#)/.test(line)) continue;
    if (REQUEST_PRIMITIVE.test(line)) {
      console.error("FAIL  verify:no-network: a test module holds a request primitive");
      console.error(`      ${file}:${index + 1}  ${line.trim()}`);
      process.exit(1);
    }
  }
}

// 步骤 10 之前，bridge 靠「恰好一处请求原语，且那处是本地协议」赢得它的豁免。
// Native 之后跨界是一个 C ABI 入口加一份生成协议，两者**一处请求原语也没有**——
// 所以断言反过来：这个文件必须是干净的。它比旧版更严，不是更松。
const bridgeSource = await Bun.file(BRIDGE).text();
const bridgeRequests = bridgeSource
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\/\*|\*|#)/.test(line))
  .filter((line) => OUTBOUND.test(line));
if (bridgeRequests.length !== 0) {
  console.error("FAIL  verify:no-network: the generated protocol must hold no request primitive");
  for (const line of bridgeRequests) console.error(`      ${line.trim()}`);
  process.exit(1);
}

// Shiki 随旧 DOM 前端退场：Native 表面不做语法高亮的运行时抓取。

/**
 * 能开 socket 的 crate，按能力分组。出现在依赖图里即红。
 *
 * 上面的正则扫的是**我们自己写的那一半**，约五个 crate；依赖图有 304 个包。
 * 两者互补不互替：一个从未写过 `fetch` 的仓库仍然可以因为某个依赖拉进一个
 * HTTP 客户端而出网，而那一次请求在我们的源码里看不见。在这一条之前，INV-1
 * 在图上成立**靠的是选依赖的运气，不靠断言**。
 *
 * **为什么读 `Cargo.lock` 而不是 `cargo metadata`**：锁文件已提交、涵盖包括
 * dev 与 build 依赖在内的全部解析结果（比运行时图更严），且不要求这台机器
 * 装有 Rust 工具链——这道门禁因此能留在 `needs: "files"` 那一档，与第一方扫描
 * 同一道门、同一份结论。一个只在另一个平台上生效的依赖也在锁里，那也该红。
 *
 * **名单是封闭集吗？不是。** 它拦的是已知的能力提供者；一个叫不出名字的新
 * 客户端仍然能滑过去。更强的那一级是二进制导入表断言（PE/ELF 里没有
 * `connect`／`WSAConnect`／`getaddrinfo`），它不在这道门禁里。
 */
const NETWORK_CRATES: readonly (readonly [string, string])[] = [
  // 异步运行时与它们的反应器：套接字就在这一层开。
  ["socket2", "raw sockets"],
  ["mio", "the reactor an async runtime opens sockets through"],
  ["tokio", "an async runtime with a network driver"],
  ["async-std", "an async runtime with a network driver"],
  ["smol", "an async runtime with a network driver"],
  ["async-io", "the reactor smol opens sockets through"],
  // HTTP 客户端与服务端。
  ["hyper", "an HTTP client and server"],
  ["h2", "an HTTP/2 stack"],
  ["reqwest", "an HTTP client"],
  ["ureq", "an HTTP client"],
  ["attohttpc", "an HTTP client"],
  ["isahc", "an HTTP client"],
  ["surf", "an HTTP client"],
  ["curl", "an HTTP client"],
  ["curl-sys", "an HTTP client"],
  ["tiny_http", "an HTTP server"],
  ["tungstenite", "a WebSocket stack"],
  ["tokio-tungstenite", "a WebSocket stack"],
  // TLS 与 QUIC：它们只在有连接要加密时才被拉进来。
  ["rustls", "a TLS stack, which exists to wrap a connection"],
  ["native-tls", "a TLS stack, which exists to wrap a connection"],
  ["openssl", "a TLS stack, which exists to wrap a connection"],
  ["openssl-sys", "a TLS stack, which exists to wrap a connection"],
  ["quinn", "a QUIC stack"],
  ["quinn-proto", "a QUIC stack"],
  // 名字解析：解一个主机名只为了连它。
  ["hickory-resolver", "a DNS resolver"],
  ["hickory-proto", "a DNS resolver"],
  ["trust-dns-resolver", "a DNS resolver"],
  ["trust-dns-proto", "a DNS resolver"],
  ["dns-lookup", "a DNS resolver"],
];

const LOCKFILE = "Cargo.lock";
const lockSource = await Bun.file(LOCKFILE).text();
const resolved = new Set(
  lockSource
    .split("\n")
    .map((line) => /^name = "(?<crate>[^"]+)"$/.exec(line)?.groups?.crate)
    .filter((name): name is string => name !== undefined),
);
// Fail closed: an empty graph means the lockfile moved or its format changed,
// and a gate that scanned nothing must never report that nothing was wrong.
if (resolved.size === 0) {
  console.error(
    `FAIL  verify:no-network: ${LOCKFILE} resolved to no packages — the scan face moved`,
  );
  process.exit(1);
}
const reachable = NETWORK_CRATES.filter(([crate]) => resolved.has(crate));
if (reachable.length !== 0) {
  console.error("FAIL  verify:no-network: the dependency graph can open a socket");
  for (const [crate, capability] of reachable) console.error(`      ${crate} — ${capability}`);
  process.exit(1);
}

console.log(
  `      ${resolved.size} resolved crates hold none of the ${NETWORK_CRATES.length} network capabilities`,
);
report(
  "verify:no-network",
  { scanned: result.scanned, findings: outsideTests },
  "an outbound request appears in the application process",
);
