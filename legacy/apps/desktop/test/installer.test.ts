import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const config = readFileSync(join(here, "..", "electron-builder.yml"), "utf8");

/**
 * INV-7: the installer changes nothing outside the folder it was given.
 *
 * electron-builder's `createDesktopShortcut` defaults to true, so an icon
 * appeared on the desktop of everyone who installed 0.1.4 — a change to their
 * machine nobody asked for, from an application whose entire argument is that
 * it does not act without a human saying so. The default is only visible by
 * reading electron-builder's source, which is exactly why it needs a test:
 * absence in the config file reads as "not configured", not as "enabled".
 */

test("the installer does not put anything on the desktop by itself", () => {
  expect(config).toMatch(/^\s*createDesktopShortcut:\s*false\s*$/m);
});

test("the installer shows its pages, so the writer can ask for the shortcut", () => {
  // `oneClick: false` is what turns the assisted installer on. Without it there
  // is no page to offer the choice on, and refusing the shortcut outright would
  // mean the writer has no way to get one.
  expect(config).toMatch(/^\s*oneClick:\s*false\s*$/m);
});

test("uninstalling leaves the writer's own settings alone", () => {
  expect(config).toMatch(/^\s*deleteAppDataOnUninstall:\s*false\s*$/m);
});

test("nothing in the packaging configuration reaches the network", () => {
  // No updater, no telemetry endpoint. Absence here is the feature, so assert
  // the explicit null rather than trusting that nobody adds one later.
  expect(config).toMatch(/^\s*publish:\s*null\s*$/m);
});
