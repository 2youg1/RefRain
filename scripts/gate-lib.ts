#!/usr/bin/env bun
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

import { Glob } from "bun";

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

export async function collect(patterns: readonly string[], root = "."): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of new Glob(pattern).scan({ cwd: root, dot: true })) {
      const normalised = file.split(/[/\\]/).join("/");
      if (!EXCLUDED.test(normalised)) files.add(normalised);
    }
  }
  return [...files].sort();
}

/** Scans files for a pattern, reporting every match with its location. */
export async function scan(
  patterns: readonly string[],
  offence: RegExp,
  options: { readonly root?: string; readonly ignoreLine?: (line: string) => boolean } = {},
): Promise<ScanResult> {
  const root = options.root ?? ".";
  const files = await collect(patterns, root);
  const findings: Finding[] = [];

  for (const file of files) {
    const text = await Bun.file(`${root}/${file}`).text();
    text.split("\n").forEach((line, index) => {
      if (options.ignoreLine?.(line)) return;
      // A fresh lastIndex per line: a /g/ regex reused across lines skips
      // matches, which would make this gate quietly miss every other offence.
      if (new RegExp(offence.source, offence.flags.replace("g", "")).test(line)) {
        findings.push({ file, line: index + 1, text: line.trim() });
      }
    });
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
