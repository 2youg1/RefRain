/**
 * The About page says what it should, and its links are real.
 *
 * It claimed "RefRain 0.1.2" for a whole release after the package said 0.1.3,
 * because the string was typed into the component. That is the kind of defect
 * a type checker cannot see and a person only notices if they look — so this
 * opens the page, reads the rendered text, and compares it with package.json.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const html = (await Bun.file(join(root, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, "dist", "renderer", path)));
  },
});

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// The bridge is stubbed whole: the renderer must never reach a real Electron
// module, and openProjectUrl records rather than opens so the assertion can
// check which address a click actually asked for.
await page.addInitScript(`
  window.__opened = [];
  window.refrain = {
    openProject: async () => "/p",
    loadProject: async () => [{ id: "01.md", title: "01", text: "黑暗中有人问。" }],
    loadWorkspace: async () => [{ id: "01.md", title: "01", text: "黑暗中有人问。", root: "/p", path: "/p/01.md" }],
    createProject: async () => null, pathFor: () => "", resolveDrop: async () => null,
    fullscreen: async () => true, onCloseRequest: () => () => {}, saveChapter: async () => ({ ok: true, edits: [] }), listAgents: async () => [],
    addAgent: async () => ({}), removeAgent: async () => true, probeAgent: async () => ({ ok: true }),
    enqueue: async () => true, manifest: async () => [], send: async () => [],
    collect: async () => ({ proposals: [], comments: [] }), runs: async () => [],
    commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
    revertEdit: async (t) => t, revertAll: async (t) => t,
    describeEdits: async () => "", systemFonts: async () => [],
    openProjectUrl: async (url) => { window.__opened.push(url); return true; },
    files: {
      scan: async () => ({ total: 0, entries: [] }), page: async () => ({ total: 0, entries: [] }),
      search: async () => ({ total: 0, entries: [] }), sort: async () => true, trash: async () => ({ ok: true }),
    },
  };
  localStorage.setItem("refrain.roots", JSON.stringify(["/p"]));
`);

await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(600);

// Command palette → Settings, the only permanent entrance (SPEC 4).
await page.keyboard.press("Control+,");
await page.waitForTimeout(400);

const about = page.locator("nav button", { hasText: /关于|About/ });
if ((await about.count()) === 0) {
  const sheets = await page.locator(".sheet, [class*=sheet]").count();
  const navs = await page.locator("nav button").allTextContents();
  throw new Error(
    `no About entry. sheets on page: ${sheets}; nav buttons: ${JSON.stringify(navs)}`,
  );
}
await about.first().click();
await page.waitForTimeout(300);

const failures: string[] = [];

const shown = (await page.locator(".version").first().textContent())?.trim() ?? "";
if (!shown.includes(version))
  failures.push(`version reads ${JSON.stringify(shown)}, package.json says ${version}`);

const links = page.locator(".links .link");
const count = await links.count();
if (count !== 4) failures.push(`expected 4 links on the About page, found ${count}`);

// Click each one and check the address main was actually asked to open.
const expected = [
  "https://github.com/kaile9/RefRain",
  "https://github.com/kaile9/RefRain/issues",
  "https://github.com/kaile9/RefRain/discussions",
  "https://github.com/kaile9/RefRain/blob/main/LICENSE",
];
for (let i = 0; i < count; i++) await links.nth(i).click();
await page.waitForTimeout(200);
const opened: string[] = JSON.parse(await page.evaluate("JSON.stringify(window.__opened || [])"));
for (const url of expected)
  if (!opened.includes(url)) failures.push(`no link asked to open ${url}`);

// A link the eye cannot separate from body text is not a link.
const colour: string = await page.evaluate(
  "getComputedStyle(document.querySelector('.links .link')).color",
);
const body: string = await page.evaluate(
  "getComputedStyle(document.querySelector('.about .quiet-text')).color",
);
if (colour === body) failures.push("links render in the same colour as the surrounding text");

await page.screenshot({ path: join(root, "shots", "about.png") });
await browser.close();
server.stop();

if (failures.length > 0) {
  for (const line of failures) console.error(`  ${line}`);
  console.error(`FAIL  ${failures.length} problem(s) on the About page`);
  process.exit(1);
}

console.log(`PASS  About shows ${version}, four links, each opening its own address`);
