import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

/**
 * Render the flow document's Mermaid blocks through the real renderer.
 *
 * A diagram that fails to parse looks identical to a correct one in the source
 * file — the failure only appears where a reader would see it. So this loads
 * the actual library, runs it, and fails loudly rather than reporting success
 * because nothing threw.
 */

const root = join(import.meta.dir);
const md = readFileSync(join(root, "docs/flow.md"), "utf8");
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f1ec;padding:30px;font-family:system-ui,sans-serif}
.d{background:#fbf9f6;border:1px solid #ddd8cf;padding:24px;margin-bottom:24px}
h3{font-size:12px;color:#8d887f;margin:0 0 16px;font-weight:400;letter-spacing:.1em}
</style></head><body>
${blocks.map((b, i) => `<div class="d"><h3>DIAGRAM ${i + 1}</h3><pre class="mermaid">${b}</pre></div>`).join("\n")}
<script type="module">
import mermaid from "./node_modules/mermaid/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: {
  fontFamily: "system-ui, sans-serif", primaryColor: "#eeeae3",
  primaryTextColor: "#22201d", lineColor: "#8d887f", primaryBorderColor: "#8d887f" } });
try { await mermaid.run(); window.__done = "ok"; }
catch (e) { window.__done = "fail: " + String(e); }
</script></body></html>`;

writeFileSync(join(root, "mermaid-check.html"), html);

/*
 * Served over loopback rather than opened as file://: Chromium blocks ES
 * module imports from a file:// origin under CORS, so the page would load and
 * the script would silently never run.
 */
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(join(root, path === "/" ? "mermaid-check.html" : path));
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});

const browser = await chromium.launch();
const page = await browser.newPage({
  viewportSize: { width: 1500, height: 2200 },
  deviceScaleFactor: 1.5,
});
const pageErrors: string[] = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(`http://localhost:${server.port}/`);
await page.waitForFunction(() => "__done" in window, undefined, { timeout: 30_000 });

const status = await page.evaluate(() => (window as unknown as { __done: string }).__done);
const svgCount = await page.locator("pre.mermaid svg").count();

/* One file per diagram: a full-page shot of both exceeds the 8000px limit. */
const cards = page.locator("div.d");
for (let i = 0; i < (await cards.count()); i++)
  await cards.nth(i).screenshot({
    path: join(root, `docs/preview-shots/flow-${i + 1}.png`),
  });
await browser.close();
server.stop();

console.log(`blocks: ${blocks.length} | rendered svg: ${svgCount} | ${status}`);
if (pageErrors.length > 0) console.log(`page errors: ${pageErrors.slice(0, 2).join(" | ")}`);

if (status !== "ok" || svgCount !== blocks.length) {
  console.error("FAIL: a diagram did not render");
  process.exit(1);
}
console.log("PASS: every diagram renders");
