/**
 * Prove every theme repaints, by clicking the control a writer clicks.
 *
 * The unit tests compare three source files against each other, which would
 * have caught the mismatch that shipped — but not a theme whose selector exists
 * and whose colours never reach the page. This drives the real settings panel
 * in a real Chromium and reads the computed paper colour back off `:root`.
 * Eight distinct results is the evidence; a repeat means the click did nothing.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = (await Bun.file(join(root, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, "dist", "renderer", p)));
  },
});

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(`${BRIDGE_STUB}
Object.assign(window.refrain, {
  openProject: async () => "/p", loadProject: async () => [], loadWorkspace: async () => ({ roots: [], chapters: [] }),
  createProject: async () => null, pathFor: () => "", resolveDrop: async () => null,
  fullscreen: async () => true, saveChapter: async () => ({ ok: true, edits: [] }),
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {},
});`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(500);

/** Open Settings → Appearance through the palette, the way the app intends. */
await page.click("body");
await page.keyboard.down("Control");
await page.keyboard.press("k");
await page.keyboard.up("Control");
await page.waitForTimeout(350);

// Click the Settings command rather than typing: the palette filters on the
// translated label, which differs by language, and this script must not care.
await page.evaluate(() => {
  const entry = [...document.querySelectorAll<HTMLElement>("button, li, [role=option]")].find(
    (node) => /设置|Settings/.test(node.textContent ?? ""),
  );
  entry?.click();
});
await page.waitForTimeout(600);

// Appearance is the first section, but say so rather than assume it.
await page.evaluate(() => {
  const nav = [...document.querySelectorAll<HTMLElement>(".settings nav button")].find((node) =>
    /外观|Appearance/.test(node.textContent ?? ""),
  );
  nav?.click();
});
await page.waitForTimeout(400);

const buttons = await page.evaluate(() =>
  [...document.querySelectorAll(".theme-group .segmented button")].map(
    (b) => b.textContent?.trim() ?? "",
  ),
);

const seen: Record<string, { paper: string; ink: string; scheme: string }> = {};
for (let i = 0; i < buttons.length; i++) {
  await page.evaluate((index) => {
    const all = [...document.querySelectorAll<HTMLElement>(".theme-group .segmented button")];
    all[index]?.click();
  }, i);
  await page.waitForTimeout(220);

  seen[buttons[i] as string] = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      paper: style.getPropertyValue("--paper").trim(),
      ink: style.getPropertyValue("--ink").trim(),
      scheme: style.colorScheme,
      // biome-ignore lint/suspicious/noExplicitAny: page context, not app code
    } as any;
  });
}

await browser.close();
server.stop();

const names = Object.keys(seen);
const papers = new Set(names.map((n) => seen[n]?.paper));
const failures: string[] = [];

if (names.length === 0) failures.push("no theme buttons rendered — the panel is not wired");
if (names.length !== 8) failures.push(`expected 8 theme buttons, found ${names.length}`);
if (papers.size !== names.length)
  failures.push(`${names.length} themes produced only ${papers.size} distinct papers`);
for (const name of names)
  if (!seen[name]?.paper) failures.push(`${name} left --paper empty: no selector matched`);

// Night themes must declare a dark color-scheme, or the OS paints scrollbars
// and form controls for a light page on top of a dark one.
const dark = names.filter((n) => seen[n]?.scheme === "dark");
if (dark.length !== 3) failures.push(`expected 3 dark-scheme themes, found ${dark.length}`);

for (const name of names)
  console.log(`  ${name.padEnd(4)} paper ${seen[name]?.paper}  scheme ${seen[name]?.scheme}`);

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL  ${line}`);
  process.exit(1);
}

console.log(`PASS  ${names.length} themes each repaint the page, ${dark.length} of them dark`);
