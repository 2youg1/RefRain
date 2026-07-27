import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDateTime, localTime } from "../src/renderer/time.ts";

/**
 * An instant is stored in UTC and shown in the author's clock.
 *
 * Both halves matter and they pull in opposite directions. A Verdict's
 * `decidedAt` has to be an absolute instant on disk, or a ledger written in
 * Tokyo and read in Berlin stops describing the same moment. But the author
 * reads it in the room they are sitting in: rendering the stored string raw
 * showed a judgment made at nine in the evening in Tokyo as noon.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const renderer = join(here, "..", "src", "renderer");
const read = (name: string): string => readFileSync(join(renderer, name), "utf8");

/**
 * Bun reads TZ once per process, so a second value cannot be had by assigning
 * `process.env.TZ` here. Formatting against an explicit zone asks the same
 * question — does the rendered value follow the clock — without the reload.
 */
const inZone = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleString("en-US", { timeZone, hour: "2-digit", minute: "2-digit" });

/** 2026-03-14T21:30:00Z — evening in Tokyo, afternoon in Berlin, morning in LA. */
const instant = "2026-03-14T21:30:00.000Z";

test("a stored instant renders differently in different zones", () => {
  const tokyo = inZone(instant, "Asia/Tokyo");
  const berlin = inZone(instant, "Europe/Berlin");
  const losAngeles = inZone(instant, "America/Los_Angeles");

  expect(tokyo).not.toBe(berlin);
  expect(berlin).not.toBe(losAngeles);

  // The defect in one line: UTC is what the raw string carries, and Tokyo is
  // nine hours from it. Slicing the ISO string showed every author London.
  expect(instant.slice(11, 16)).toBe("21:30");
  expect(tokyo).toBe("06:30 AM");
});

test("the stored value is never rewritten by display", () => {
  const before = instant;
  localTime(instant);
  localDateTime(instant);
  expect(instant).toBe(before);
  // What a Verdict carries to disk stays a UTC instant, parseable anywhere.
  expect(new Date(instant).toISOString()).toBe(instant);
});

test("display converts out of UTC in the running zone", () => {
  const shown = localDateTime(instant);
  const offsetMinutes = new Date(instant).getTimezoneOffset();

  expect(shown).not.toBe(instant);
  // Under a zone that is not UTC the rendered clock must differ from the
  // stored one; under UTC itself agreeing is the correct answer.
  if (offsetMinutes !== 0) expect(shown).not.toContain("21:30");
  expect(localTime(instant)).toBe(
    new Date(instant).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  );
});

test("an unparseable stamp is shown as stored rather than as Invalid Date", () => {
  expect(localTime("not-a-date")).toBe("not-a-date");
  expect(localDateTime("")).toBe("");
});

/**
 * The Ledger was fixed one release before the Edits panel, and the Edits panel
 * kept slicing characters 11 to 16 off the ISO string the whole time. Two
 * surfaces formatting instants privately is how that gap survived, so the test
 * is against the source: a component showing a stamp goes through time.ts.
 */
test("no renderer component formats an instant on its own", () => {
  for (const file of ["Ledger.svelte", "Edits.svelte"]) {
    const source = read(file);
    expect(source).toContain("./time.ts");
    expect(source).not.toContain("toLocaleString(");
    expect(source).not.toMatch(/\.at\.slice\(|decidedAt\.slice\(/);
  }
});
