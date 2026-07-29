#!/usr/bin/env bun
/**
 * INV-10: every persistent fact has exactly one owner, and for user settings
 * and Harness Connection parameters that owner is `config.toml` (SPEC 10.1,
 * D18). Two competing surfaces are therefore defects, not conveniences:
 *
 * - a preferences/settings table in either database schema, and
 * - `localStorage` in the renderer, which v0.1.x used as the settings
 *   authority; in v0.2 it may hold no settings at all.
 *
 * The runtime half of the invariant is ConfigStore itself (damaged and newer
 * files are refused); this gate is the static half that keeps a second
 * authority from being re-introduced.
 *
 * Injection proof that this gate bites: add the word `preferences` to
 * `crates/refrain-store/src/schema.rs` and this exits 1 naming the line.
 */

import { report, scan } from "./gate-lib.ts";

const schema = await scan(["crates/refrain-store/src/*.rs"], /preferences/i, {
  ignoreLine: (line) => line.trimStart().startsWith("//") || line.trimStart().startsWith("!"),
});

const renderer = await scan(
  ["apps/desktop/src/**/*.ts", "apps/desktop/src/**/*.vue"],
  /localStorage/,
  {
    ignoreLine: (line) =>
      // Comments explain the rule; they do not break it.
      /^\s*(\/\/|\/\*|\*)/.test(line) ||
      // The `refrain.e2e.` prefix names a test seam (the picker answer the
      // WebDriver harness plants), never a setting. It is the only page-global
      // use the renderer may have, and it is read in exactly one file.
      line.includes("refrain.e2e."),
  },
);

const findings = [...schema.findings, ...renderer.findings];
report(
  "verify:config-authority",
  { scanned: schema.scanned + renderer.scanned, findings },
  "settings belong to config.toml alone — no database table, no localStorage",
);
