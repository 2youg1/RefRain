/**
 * Render the application mark to the PNG electron-builder needs.
 *
 * The mark is an SVG whose stroke is `currentColor` and whose accent is a theme
 * variable, so one file serves every theme. A packaged icon has no cascade to
 * inherit from, which is why this fixes both explicitly rather than exporting
 * the file as-is and getting a black square.
 *
 * Chromium rather than a conversion library: it is already installed for the
 * rendering checks, and it is the same engine that draws the mark in the app.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const mark = readFileSync(join(root, "src/renderer/assets/mark.svg"), "utf8");

/** 512 is what electron-builder wants for Linux; it downsamples the rest. */
const SIZE = 512;

/**
 * 0.72 of the canvas rather than 0.62: at the smaller figure the hairline rule
 * measured about seven pixels here, which is sub-pixel by the time a desktop
 * draws a 32px icon. `mark-16.svg` exists for the sizes below that.
 */
const MARK_FRACTION = 0.72;

const style = [
  `html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; }`,
  "body { display: grid; place-items: center;",
  // The paper the mark sits on in the rain theme, so the icon reads as the
  // application rather than as a glyph floating on nothing.
  "  background: #faf9f7;",
  // The mark takes its stroke from currentColor and its accent from
  // --role-pending; an icon has no cascade, so both are set here.
  "  color: #2b2b2b; --role-pending: #c1542f; }",
  `svg { width: ${Math.round(SIZE * MARK_FRACTION)}px;`,
  `      height: ${Math.round(SIZE * MARK_FRACTION)}px; }`,
].join("\n");

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: SIZE, height: SIZE },
  deviceScaleFactor: 1,
});

await page.setContent(`<!doctype html><style>${style}</style>${mark}`);
await page.waitForTimeout(200);

mkdirSync(join(root, "build"), { recursive: true });
const target = join(root, "build", "icon.png");
await page.screenshot({ path: target, omitBackground: false });

await browser.close();

// A screenshot that rendered nothing is still a valid PNG, so check the bytes
// rather than trusting that the call returned.
const written = readFileSync(target);
if (written.length < 2000) {
  console.error(`icon.png is ${written.length} bytes — the mark did not render`);
  process.exit(1);
}

console.log(`icon → ${target} (${Math.round(written.length / 1024)} KB)`);
