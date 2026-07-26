import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const docs = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`file://${join(docs, "theme-preview.html")}`);
await page.waitForTimeout(1200);

const cards = await page.locator(".th-card, section.theme, .theme-card").count();
console.log("theme sections:", cards);

const names = ["ink", "wabi", "sand", "tex", "wave", "korea", "birch", "editorial", "fresh"];
for (const [i, name] of names.entries()) {
  const el = page.locator("section.theme").nth(i);
  if ((await el.count()) === 0) break;
  await el.screenshot({ path: join(docs, "preview-shots", `theme-${i + 1}-${name}.png`) });
  console.log(`  ${name}`);
}
const paper = page.locator("#paper");
if ((await paper.count()) > 0) {
  await paper.screenshot({ path: join(docs, "preview-shots", "99-paper-modes.png") });
  console.log("  paper modes");
}
await page.screenshot({ path: join(docs, "preview-shots", "00-full-page.png"), fullPage: true });
await browser.close();
