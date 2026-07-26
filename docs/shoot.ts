/**
 * Render the theme preview to PNG.
 *
 * Source code is weak evidence about a palette: a hex value that reads well in
 * a table can sit wrong against its neighbours. These shots are what gets
 * reviewed. The preview parses the generated themes.css, so what is pictured
 * is what the application actually loads.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const docs = dirname(fileURLToPath(import.meta.url));
const shots = join(docs, "preview-shots");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1260, height: 1100 }, deviceScaleFactor: 2 });
await page.goto(`file://${join(docs, "theme-preview.html")}`);
await page.waitForTimeout(900);

const cards = page.locator("section.card");
const count = await cards.count();
console.log(`themes: ${count}`);
if (count !== 8) throw new Error(`expected 8 theme cards, found ${count}`);

// Element screenshots, not viewport clips: a clip is viewport-relative, so
// every card below the fold fails with "clipped area outside the image".
const slugs = ["tou", "kasumi", "kare", "hayashi", "seiji", "sumi", "yu", "shigure"];
for (const [i, slug] of slugs.entries()) {
  await page.locator(`#${slug}`).screenshot({ path: join(shots, `theme-${i + 1}-${slug}.png`) });
  console.log(`  ${slug}`);
}

await page.screenshot({ path: join(shots, "00-themes.png"), fullPage: true });
await browser.close();
console.log("done");
