#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared scanning for the verification gates.
 *
 * Every gate here answers the same shape of question: over this set of files,
 * does this forbidden pattern appear? The part worth centralising is not the
 * matching — it is the refusal to pass on an empty scan.
 *
 * A guard that scans zero files exits 0 and reads as coverage. That is how a
 * gate dies: someone moves a directory, the glob still resolves, and the check
 * silently becomes a no-op nobody notices for weeks.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface ScanResult {
  readonly scanned: number;
  readonly findings: readonly Finding[];
}

/** Directories no gate should read: dependencies, build output, the old stack. */
const EXCLUDED = /(^|\/)(node_modules|dist|target|legacy|\.git)(\/|$)/;

/**
 * Compiles a glob pattern to a regular expression.
 *
 * The gates use three constructs: `**` across directories, `*` inside one
 * segment, and `{a,b}` alternation. Anything else is matched literally, so an
 * unsupported construct fails closed as a non-match rather than silently
 * widening the scan.
 */
const globToRegExp = (pattern: string): RegExp => {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === "*") {
      if (pattern.charAt(i + 1) === "*") {
        // `**/` crosses directories and also matches zero of them.
        if (pattern.charAt(i + 2) === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const options = pattern.slice(i + 1, close).split(",");
        out += `(?:${options.map((o) => o.split(".").join("\\.")).join("|")})`;
        i = close;
        continue;
      }
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += "\\^$.|+()[]{}".includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`);
};

const walk = (root: string, prefix: string, out: string[]): void => {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = `${root}/${entry}`;
    const relative = prefix === "" ? entry : `${prefix}/${entry}`;
    if (EXCLUDED.test(relative)) continue;
    let isDirectory = false;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) walk(full, relative, out);
    else out.push(relative);
  }
};

export function collect(patterns: readonly string[], root = "."): string[] {
  const every: string[] = [];
  walk(root, "", every);

  const files = new Set<string>();
  for (const pattern of patterns) {
    const matcher = globToRegExp(pattern);
    for (const candidate of every) {
      if (matcher.test(candidate)) files.add(candidate);
    }
  }
  return [...files].sort();
}

/** Scans files for a pattern, reporting every match with its location. */
export function scan(
  patterns: readonly string[],
  offence: RegExp,
  options: {
    readonly root?: string;
    readonly ignoreLine?: (line: string) => boolean;
    /**
     * Exclude a file from this scan because a separate, stricter assertion
     * covers it. A gate that merely ignores a line lets an offence hide beside
     * the permitted one; excluding the file forces the caller to state what it
     * asserts instead.
     */
    readonly skipFile?: (file: string) => boolean;
  } = {},
): ScanResult {
  const root = options.root ?? ".";
  const files = collect(patterns, root);
  const findings: Finding[] = [];

  // A fresh matcher without /g/: a /g/ regex reused across lines carries
  // lastIndex forward and skips matches, which would make this gate quietly
  // miss every other offence.
  const flags = [...offence.flags].filter((flag) => flag !== "g").join("");
  const perLine = new RegExp(offence.source, flags);

  for (const file of files) {
    if (options.skipFile?.(file)) continue;
    const text = readFileSync(`${root}/${file}`, "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (options.ignoreLine?.(line)) continue;
      if (perLine.test(line)) {
        findings.push({ file, line: index + 1, text: line.trim() });
      }
    }
  }

  return { scanned: files.length, findings };
}

/**
 * Reports a gate's result and exits.
 *
 * The target count is printed on success as well as failure. A gate that
 * scanned nothing fails here regardless of its findings, because "no offences
 * in zero files" is the answer a broken scanner gives.
 */
export function report(gate: string, result: ScanResult, explain: string): never {
  if (result.scanned === 0) {
    console.error(`FAIL  ${gate}: scanned 0 files — the scan is looking in the wrong place`);
    process.exit(1);
  }

  if (result.findings.length > 0) {
    console.error(`FAIL  ${gate}: ${explain}`);
    for (const finding of result.findings) {
      console.error(`      ${finding.file}:${finding.line}  ${finding.text}`);
    }
    console.error(`      ${result.findings.length} offence(s) across ${result.scanned} files`);
    process.exit(1);
  }

  console.log(`PASS  ${gate}  (${result.scanned} files scanned)`);
  process.exit(0);
}
