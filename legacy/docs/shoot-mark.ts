import { chromium } from "playwright";
import { join } from "node:path";
const d = import.meta.dir;
const b = await chromium.launch();
const p = await b.newPage({ viewportSize: { width: 1080, height: 760 }, deviceScaleFactor: 2 });
await p.goto("file://" + join(d, "mark-themes.html"));
await p.waitForTimeout(300);
await p.screenshot({ path: join(d, "preview-shots", "mark-themes.png"), fullPage: true });
await b.close(); console.log("ok");
