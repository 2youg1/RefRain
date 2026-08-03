#!/usr/bin/env bun
/**
 * Keep the temporary Native migration ledger equal to three finite source sets.
 * Delete this script and the ledger in Roadmap step 10 after permanent tests own
 * every covered rule and the old bindings and e2e drivers are gone.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LEDGER = "apps/native/migration/ledger.json";
const BINDINGS = "apps/desktop/src/generated/bindings.gen.ts";
type CensusName = "commands" | "productRules" | "e2eDrivers";
const CENSUS_NAMES: readonly CensusName[] = ["commands", "productRules", "e2eDrivers"];
const EXPECTED: Readonly<Record<CensusName, number>> = {
  commands: 64,
  productRules: 696,
  e2eDrivers: 34,
};
const STATUSES = new Set(["pending", "covered", "merged", "removed"]);

interface SourceItem {
  readonly id: string;
  readonly file: string;
  readonly context: string;
  readonly label: string;
}

function fail(message: string): never {
  throw new Error(`native migration ledger: ${message}`);
}

function commandItems(): SourceItem[] {
  const source = readFileSync(BINDINGS, "utf8");
  const start = source.indexOf("export const commands = {");
  const end = source.indexOf("\n};", start);
  if (start < 0 || end < 0) fail(`${BINDINGS} must contain one generated commands object`);
  const items: SourceItem[] = [];
  for (const match of source.slice(start, end).matchAll(/^\t([A-Za-z_$][A-Za-z0-9_$]*): \(/gm)) {
    const name = match[1];
    if (name === undefined) fail("generated command name vanished");
    items.push({
      id: `command:${name}`,
      file: BINDINGS,
      context: "generated command",
      label: name,
    });
  }
  return sortedUnique(items, "command");
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_whole: string, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_whole: string, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function attributes(raw: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) fail("JUnit emitted an incomplete attribute");
    out[name] = decodeXml(value);
  }
  return out;
}

function requiredAttribute(values: Readonly<Record<string, string>>, name: string): string {
  const value = values[name];
  if (value === undefined || value.length === 0) fail(`JUnit testcase lacks ${name}`);
  return value;
}

function productRuleItems(): SourceItem[] {
  const directory = mkdtempSync(join(tmpdir(), "refrain-ledger-"));
  const report = join(directory, "tests.xml");
  try {
    const result = spawnSync(
      "bun",
      [
        "test",
        "--path-ignore-patterns=**/legacy/**",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").slice(-12);
      fail(`test census failed:\n${detail.join("\n")}`);
    }
    const xml = readFileSync(report, "utf8");
    const items: SourceItem[] = [];
    for (const match of xml.matchAll(/<testcase\b([^>]*)\/>/g)) {
      const raw = match[1];
      if (raw === undefined) fail("JUnit emitted an incomplete testcase");
      const values = attributes(raw);
      const file = requiredAttribute(values, "file");
      if (file.startsWith("apps/native/")) continue;
      const context = requiredAttribute(values, "classname");
      const label = requiredAttribute(values, "name");
      const key = `${file}\0${context}\0${label}`;
      const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
      items.push({ id: `rule:${digest}`, file, context, label });
    }
    return sortedUnique(items, "product rule");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function e2eDriverItems(): SourceItem[] {
  const result = spawnSync("git", ["ls-files", "-z", "--", "apps/desktop/e2e", "e2e/ime"], {
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`git ls-files failed: ${(result.stderr ?? "").trim()}`);
  const files = (result.stdout ?? "").split("\0").filter((file) => /\.(?:ts|tsx|ps1)$/.test(file));
  return sortedUnique(
    files.map(
      (file): SourceItem => ({
        id: `e2e:${file}`,
        file,
        context: file.startsWith("e2e/ime/") ? "Windows IME" : "desktop e2e",
        label: file.slice(file.lastIndexOf("/") + 1),
      }),
    ),
    "e2e driver",
  );
}

function sortedUnique(items: SourceItem[], kind: string): SourceItem[] {
  items.sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < items.length; index += 1) {
    if (items[index - 1]?.id === items[index]?.id) fail(`${kind} id ${items[index]?.id} repeats`);
  }
  return items;
}

function census(): Readonly<Record<CensusName, SourceItem[]>> {
  const result = {
    commands: commandItems(),
    productRules: productRuleItems(),
    e2eDrivers: e2eDriverItems(),
  };
  for (const name of CENSUS_NAMES) {
    if (result[name].length !== EXPECTED[name]) {
      fail(`${name} has ${result[name].length} items; expected ${EXPECTED[name]}`);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Readonly<Record<string, unknown>>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) fail(`ledger item lacks ${name}`);
  return field;
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${label} must be a non-empty string array`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0)
      fail(`${label} must be a non-empty string array`);
    out.push(item);
  }
  return out;
}

function validateItems(value: unknown, current: readonly SourceItem[], kind: string): void {
  if (!Array.isArray(value)) fail(`${kind} must be an array`);
  if (value.length !== current.length)
    fail(`${kind} has ${value.length} entries; census has ${current.length}`);
  const sources = new Map(current.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const allowed = new Set([
    "id",
    "file",
    "context",
    "label",
    "status",
    "target",
    "tests",
    "reason",
  ]);
  for (const raw of value) {
    if (!isRecord(raw)) fail(`${kind} contains a non-object entry`);
    for (const key of Object.keys(raw))
      if (!allowed.has(key)) fail(`${kind} item has unknown field ${key}`);
    const id = stringField(raw, "id");
    if (seen.has(id)) fail(`${kind} repeats ${id}`);
    seen.add(id);
    const source = sources.get(id);
    if (source === undefined) fail(`${kind} contains stale or invented id ${id}`);
    const sourceFields: readonly ("file" | "context" | "label")[] = ["file", "context", "label"];
    for (const name of sourceFields) {
      if (stringField(raw, name) !== source[name]) fail(`${id} ${name} drifted from its source`);
    }
    const status = stringField(raw, "status");
    if (!STATUSES.has(status)) fail(`${id} has invalid status ${status}`);
    if (status === "pending") {
      if (raw.target !== undefined || raw.tests !== undefined || raw.reason !== undefined) {
        fail(`${id} is pending but carries migration evidence`);
      }
    } else if (status === "removed") {
      stringField(raw, "reason");
      if (raw.target !== undefined || raw.tests !== undefined)
        fail(`${id} is removed but carries a target`);
    } else {
      stringField(raw, "target");
      stringList(raw.tests, `${id} tests`);
      if (raw.reason !== undefined) fail(`${id} is ${status} but carries a removal reason`);
    }
  }
  for (const source of current) if (!seen.has(source.id)) fail(`${kind} omits ${source.id}`);
}

const inventory = census();
if (process.argv.includes("--write")) {
  if (existsSync(LEDGER)) fail(`${LEDGER} already exists; do not erase migration decisions`);
  mkdirSync(dirname(LEDGER), { recursive: true });
  const pending = (items: readonly SourceItem[]) =>
    items.map((item) => ({ ...item, status: "pending" }));
  writeFileSync(
    LEDGER,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        deletionCondition:
          "Roadmap step 10: permanent tests own every migrated rule and old bindings/e2e are deleted",
        commands: pending(inventory.commands),
        productRules: pending(inventory.productRules),
        e2eDrivers: pending(inventory.e2eDrivers),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `WROTE  native migration ledger  (${EXPECTED.commands} commands, ${EXPECTED.productRules} rules, ${EXPECTED.e2eDrivers} e2e drivers)`,
  );
} else {
  const parsed: unknown = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) fail("ledger schemaVersion must be 1");
  validateItems(parsed.commands, inventory.commands, "commands");
  validateItems(parsed.productRules, inventory.productRules, "productRules");
  validateItems(parsed.e2eDrivers, inventory.e2eDrivers, "e2eDrivers");
  console.log(
    `PASS  native migration ledger  (${EXPECTED.commands} commands, ${EXPECTED.productRules} rules, ${EXPECTED.e2eDrivers} e2e drivers)`,
  );
}
