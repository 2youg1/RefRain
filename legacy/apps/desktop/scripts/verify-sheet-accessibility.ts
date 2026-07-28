#!/usr/bin/env bun
/**
 * Stage and Reference Sheets are nonmodal drawers (SPEC Q16): they identify
 * themselves, take a useful first focus, leave the rest of the app reachable,
 * and return a direct trigger after App's one Escape owner closes them.
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
  const viewport = { width: 1440, height: 900 };
  const page = await browser.newPage({ viewport });
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

  const manuscript = page.getByRole("textbox", { name: "manuscript" });
  const paletteKey = page.locator(".key").first();
  await manuscript.focus();
  await page.keyboard.press("Control+,");

  const sheet = page.getByRole("dialog", { name: "设置" });
  await sheet.waitFor();
  await sheet.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  const semantics = await sheet.evaluate((element, viewport) => {
    const label = element.getAttribute("aria-labelledby");
    const scrim = document.querySelector(".scrim");
    const box = element.getBoundingClientRect();
    return {
      modal: element.getAttribute("aria-modal"),
      title: label ? document.getElementById(label)?.textContent : null,
      focusClass: document.activeElement?.className ?? null,
      scrimPointerEvents: scrim ? getComputedStyle(scrim).pointerEvents : null,
      edges: {
        top: box.top,
        right: viewport.width - box.right,
        bottom: viewport.height - box.bottom,
      },
    };
  }, viewport);
  if (semantics.modal !== null) throw new Error(`Sheet falsely claims modal=${semantics.modal}`);
  if (semantics.title !== "设置")
    throw new Error(`Sheet is not labelled by its title: ${semantics.title}`);
  if (!semantics.focusClass?.split(" ").includes("close"))
    throw new Error(`Sheet did not initially focus its close control: ${semantics.focusClass}`);
  if (semantics.scrimPointerEvents !== "none")
    throw new Error(
      `nonmodal Sheet blocks the app with scrim pointer-events=${semantics.scrimPointerEvents}`,
    );
  if (Object.values(semantics.edges).some((edge) => Math.abs(edge) > 0.5))
    throw new Error(`Sheet is not flush to the viewport: ${JSON.stringify(semantics.edges)}`);
  await page.screenshot({ path: join(shots, "sheet-nonmodal.png"), fullPage: true });

  await page.keyboard.press("Shift+Tab");
  if (await sheet.evaluate((element) => element.contains(document.activeElement)))
    throw new Error("nonmodal Sheet traps Shift+Tab inside the drawer");
  if (!(await sheet.isVisible())) throw new Error("Tab traversal dismissed the Sheet");

  await sheet.getByRole("button", { name: "关闭" }).focus();
  await page.keyboard.press("Control+K");
  await page.keyboard.press("Escape");
  if (!(await sheet.isVisible())) throw new Error("one Escape closed both Palette and Sheet");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  if (!(await manuscript.evaluate((element) => document.activeElement === element)))
    throw new Error("closing the Sheet did not restore its direct trigger");

  await manuscript.focus();
  await page.keyboard.press("Control+,");
  await sheet.waitFor();
  await manuscript.evaluate((element) => {
    (element as HTMLElement).inert = true;
  });
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  if (!(await paletteKey.evaluate((element) => document.activeElement === element)))
    throw new Error("an unfocusable direct trigger did not fall back to the Ctrl-K control");
  await manuscript.evaluate((element) => {
    (element as HTMLElement).inert = false;
  });

  await page.keyboard.press("Control+K");
  await page.locator(".menu .row").filter({ hasText: "设置" }).click();
  await sheet.waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  if (!(await paletteKey.evaluate((element) => document.activeElement === element)))
    throw new Error("a Palette-opened Sheet did not return to the persistent Ctrl-K control");

  await manuscript.focus();
  await manuscript.evaluate((element) => {
    const paragraph = element.firstChild;
    if (!paragraph) throw new Error("fixture manuscript has no paragraph");
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await manuscript.click({ button: "right" });
  await page.locator("menu.menu .item.accent").click();
  const dispatch = page.locator("dialog.sheet");
  await dispatch.waitFor();
  await page.keyboard.press("Escape");
  await dispatch.waitFor({ state: "detached" });
  if (!(await manuscript.evaluate((element) => document.activeElement === element)))
    throw new Error("a context-menu Sheet did not return focus to the manuscript");

  console.log("PASS  Sheet is nonmodal and restores direct, Palette, and context-menu focus paths");
} finally {
  await browser.close();
  server.stop(true);
}
