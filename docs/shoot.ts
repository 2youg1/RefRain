/**
 * Render the theme preview to PNG.
 *
 * Source code is weak evidence about a palette: a hex value that reads well in
 * a table can sit wrong against its neighbours. These shots are what gets
 * reviewed, and the review happens before any of it reaches `app.css`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const docs = dirname(fileURLToPath(import.meta.url));
const shots = join(docs, "preview-shots");

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1460, height: 1100 },
  deviceScaleFactor: 2,
});
await page.goto(`file://${join(docs, "theme-preview.html")}`);
await page.waitForTimeout(900);

const cards = page.locator("section.card");
const count = await cards.count();
console.log(`themes: ${count}`);
if (count !== 7) throw new Error(`expected 7 theme cards, found ${count}`);

// Element screenshots, not viewport clips: a clip is viewport-relative, so
// every card below the fold failed with "clipped area outside the image".
const names = ["tou", "sumi", "wabi", "sa", "shao", "kaba", "kasumi"];
const order = ["tou", "sumi", "wabi", "sa", "shao", "hua", "xia"];
for (const [i, id] of order.entries()) {
  await page.locator(`#${id}`).screenshot({ path: join(shots, `theme-${i + 1}-${names[i]}.png`) });
  console.log(`  ${names[i]}`);
}

await page.screenshot({ path: join(shots, "00-themes.png"), fullPage: true });
await browser.close();
console.log("done");
