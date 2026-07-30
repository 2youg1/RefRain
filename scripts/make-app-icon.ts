#!/usr/bin/env bun

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const sourcePath = "apps/desktop/src/assets/mark.svg";
const componentPath = "apps/desktop/src/ui/LogoMark.tsx";
const outputDir = "apps/desktop/src-tauri/icons";
const outputPng = join(outputDir, "icon.png");
const mark = readFileSync(sourcePath, "utf8");
const component = readFileSync(componentPath, "utf8");
const paths = [...mark.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1]);

for (const path of paths) {
  if (path === undefined || !component.includes(`d="${path}"`)) {
    throw new Error("LogoMark.tsx does not match the SVG geometry");
  }
}

const work = mkdtempSync(join(tmpdir(), "refrain-icon-"));
const sourcePng = join(work, "source.png");
const generated = join(work, "generated");
try {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
    await page.setContent(`
      <style>
        html, body { width: 512px; height: 512px; margin: 0; }
        body { display: grid; place-items: center; color: #2b2b2b; background: #faf9f7; --seal: #c1542f; }
        svg { width: 368px; height: 368px; }
      </style>
      ${mark}
    `);
    await page.screenshot({ path: sourcePng });
  } finally {
    await browser.close();
  }

  const result = Bun.spawnSync(
    ["bun", "x", "tauri", "icon", resolve(sourcePng), "--output", resolve(generated)],
    { cwd: "apps/desktop" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  copyFileSync(join(generated, "icon.png"), outputPng);
  copyFileSync(join(generated, "icon.ico"), join(outputDir, "icon.ico"));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`icon → ${outputPng}`);
console.log(`icon → ${join(outputDir, "icon.ico")}`);
