/**
 * Changing a typeface must change the manuscript, not only the specimen.
 *
 * The reported symptom was that switching fonts moved the preview and left the
 * text alone. Two faults produced it: every entry in the system-font list wrote
 * `cjkFamily` whatever slot the author meant, and the manuscript stack had no
 * Japanese slot at all, so Japanese fell through to whatever the machine
 * supplied. This drives the real panel and reads the computed family off the
 * manuscript element — the thing the writer is actually looking at.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const html = (await Bun.file(join(desktop, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(desktop, "dist", "renderer", path)));
  },
});

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(`window.refrain = {
  openProject: async () => "/w", openFile: async () => null, createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  loadProject: async () => [], saveChapter: async () => ({ ok: true, edits: [] }),
  loadWorkspace: async (roots) => ({
    roots: [{ id: "r1", path: roots[0], name: "w", kind: "folder" }],
    chapters: [{ id: "01.md", title: "01", text: "黒い雨。直骨令。The measure of a line.",
      rootId: "r1", root: roots[0], role: "chapter", path: roots[0] + "/01.md" }] }),
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }), ledger: async () => [], reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onCloseRequest: () => () => {},
  fonts: async () => ["Probe Serif One", "Probe Sans Two"],
  systemFonts: async () => ["Probe Serif One", "Probe Sans Two"],
};`);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);

await page.evaluate(() => {
  [...document.querySelectorAll<HTMLElement>("button")]
    .find((b) => /打开文件夹|Open folder/.test(b.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(700);

const failures: string[] = [];

/** What the manuscript element is actually set in, per the cascade. */
const manuscriptFamily = (): Promise<string> =>
  page.evaluate(() => {
    const el = document.querySelector(".manuscript");
    return el ? getComputedStyle(el).fontFamily : "";
  });

const bundled = await manuscriptFamily();

// All three slots must be present in the stack the manuscript actually uses.
// The Japanese default is a mincho: Japanese body text is set in mincho, and
// the slot had only ever offered a gothic — the equivalent of defaulting Latin
// prose to a display face.
for (const [face, why] of [
  ["Antic Didone", "the Latin face"],
  ["Shippori Mincho", "the Japanese face"],
  ["Chiron Sung HK", "the Chinese face"],
] as const)
  if (!bundled.includes(face)) failures.push(`${why} is not in the manuscript stack: ${bundled}`);

// Order decides which face wins a character all three carry. Japanese must
// precede Chinese, or 直 骨 令 are set in the Chinese forms for a Japanese
// reader — the reason these are two slots and not one.
if (bundled.indexOf("Shippori") > bundled.indexOf("Chiron"))
  failures.push(`the Japanese face sits after the Chinese one: ${bundled}`);

// The faces must have loaded, not merely been named. `document.fonts.check`
// answers true for anything substitutable, so ask the font set directly.
const loaded = await page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].map((f) => f.family);
});
for (const face of [
  "Chiron Sung HK",
  "Noto Sans SC",
  "Shippori Mincho",
  "Zen Kaku Gothic New",
  "Murecho",
  "Antic Didone",
])
  if (!loaded.includes(face)) failures.push(`${face} never loaded: ${JSON.stringify(loaded)}`);

/*
 * Murecho is a Japanese sans, and it was offered as a Chinese option while
 * also sitting ahead of PingFang and Microsoft YaHei in the interface stack —
 * so the whole interface rendered Chinese in Japanese letterforms, 直 骨 令
 * among them, without anything on screen saying so.
 */
const interfaceStack = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
const chinese = interfaceStack.indexOf("Noto Sans SC");
const japanese = interfaceStack.indexOf("Murecho");
// Absent reads as -1, and -1 is less than everything — so the ordering test
// has to be told the Chinese face is there at all before it compares.
if (chinese === -1) failures.push(`the interface stack has no Chinese face: ${interfaceStack}`);
else if (japanese !== -1 && japanese < chinese)
  failures.push(`the interface sets Chinese in a Japanese face: ${interfaceStack}`);

// ── Choosing a system face fills the slot the author selected ────
// Typography is a section of Settings, reached through the palette.
await page.click("body");
await page.keyboard.down("Control");
await page.keyboard.press("k");
await page.keyboard.up("Control");
await page.waitForTimeout(350);
await page.evaluate(() => {
  [...document.querySelectorAll<HTMLElement>("button, li, [role=option]")]
    .find((n) => /排版|Typography/.test(n.textContent ?? ""))
    ?.click();
});
await page.waitForTimeout(700);

const panel = await page.evaluate(() => !!document.querySelector(".typography .slot"));
if (!panel) failures.push("the typography panel offers no slot selector");
else {
  // Pick the Latin slot, then a system face: it must land in Latin, not Chinese.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLElement>(".typography .slot button")];
    buttons[buttons.length - 1]?.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    [...document.querySelectorAll<HTMLElement>(".typography .font-list button")]
      .find((b) => /Probe Serif One/.test(b.textContent ?? ""))
      ?.click();
  });
  await page.waitForTimeout(400);

  const after = await manuscriptFamily();
  if (!after.includes("Probe Serif One"))
    failures.push(`the chosen face never reached the manuscript: ${after}`);
  if (!after.includes("Chiron Sung HK"))
    failures.push(`choosing a Latin face overwrote the Chinese one: ${after}`);
  // It must lead the stack, or the CJK faces answer for Latin characters first.
  if (after.indexOf("Probe Serif One") > after.indexOf("Chiron Sung HK"))
    failures.push(`the Latin face does not lead the stack: ${after}`);

  console.log(`  stack ${after}`);
}

await browser.close();
server.stop();

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL  ${line}`);
  process.exit(1);
}

console.log("PASS  three slots reach the manuscript, in an order that decides the shared glyphs");
