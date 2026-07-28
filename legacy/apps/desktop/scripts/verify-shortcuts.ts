#!/usr/bin/env bun
/**
 * A refused shortcut is visible, not merely present in the DOM.
 *
 * Accessibility lookup can find an alert that occupies no rendered pixels.
 * This drives the built renderer through the real Settings path, waits for the
 * page's fonts to settle, and measures the space the refusal actually occupies.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

const desktop = join(import.meta.dir, "..");
const shots = join(desktop, "shots");
mkdirSync(shots, { recursive: true });
const html = (await Bun.file(join(desktop, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(desktop, "dist", "renderer", path)), {
      headers: { "cache-control": "no-store" },
    });
  },
});

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(`${BRIDGE_STUB}
    Object.assign(window.refrain, {
      loadWorkspace: async () => ({
        roots: [{ id: "r1", path: "/p", name: "小说", kind: "folder" }],
        chapters: [{ id: "01.md", title: "第一章", text: "雨落在纸上。", rootId: "r1", root: "/p", role: "chapter", path: "/p/01.md" }]
      })
    });
    localStorage.setItem("refrain.roots", JSON.stringify(["/p"]));
  `);
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForSelector(".writing");
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "快捷键" }).click();

  const chord = page.locator("button.chord").first();
  await chord.click();
  await chord.press("Control+C");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });

  const alert = page.getByRole("alert");
  const text = await alert.textContent();
  const box = await alert.boundingBox();
  if (!(await alert.isVisible()) || !box || box.height < 1)
    throw new Error(`shortcut refusal occupies no visible pixels: ${JSON.stringify(box)}`);
  if (!text?.includes("复制"))
    throw new Error(`shortcut refusal does not name the collision: ${text}`);

  await page.screenshot({ path: join(shots, "shortcuts-refusal.png"), fullPage: true });
  console.log(
    `PASS  shortcut refusal is ${box.height.toFixed(1)}px high and names the Copy collision`,
  );
} finally {
  await browser.close();
  server.stop(true);
}
