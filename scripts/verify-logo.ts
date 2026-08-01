#!/usr/bin/env bun

import { chromium } from "playwright";
import { ensureNodeDriver } from "./pw-chromium.ts";

ensureNodeDriver(import.meta.url);

const source = await Bun.file("apps/desktop/src/assets/mark.svg").text();
const compact = await Bun.file("apps/desktop/src/assets/mark-16.svg").text();
const component = await Bun.file("apps/desktop/src/ui/LogoMark.tsx").text();
const packager = await Bun.file("scripts/make-app-icon.ts").text();

const geometries = [...source.matchAll(/\sd="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((value): value is string => value !== undefined);
const compactShapes = [...compact.matchAll(/<(?:path|rect)\b/g)];
const failures: string[] = [];

if (geometries.length === 0) failures.push("the mark source has no geometry");
for (const geometry of geometries) {
  if (!component.includes(`d="${geometry}"`)) {
    failures.push(`LogoMark.tsx drifted from geometry ${geometry}`);
  }
}
if (compactShapes.length < 4) failures.push("the 16 px mark lost its simplified shapes");
for (const path of ["src/assets/mark.svg", "src/ui/LogoMark.tsx"]) {
  if (!packager.includes(path)) failures.push(`the icon generator does not name ${path}`);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const pixelStats = await page.evaluate(
    async ({ full, small }) => {
      const render = async (svg: string, size: number) => {
        const image = new Image();
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        try {
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("2D canvas unavailable");
          context.drawImage(image, 0, 0, size, size);
          const pixels = context.getImageData(0, 0, size, size).data;
          let visible = 0;
          for (let index = 3; index < pixels.length; index += 4) {
            if ((pixels[index] ?? 0) > 20) visible += 1;
          }
          return { size, visible };
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      const rows = [];
      for (const size of [16, 24, 32, 64]) {
        rows.push(await render(size === 16 ? small : full, size));
      }
      return rows;
    },
    { full: source, small: compact },
  );
  for (const row of pixelStats) {
    const ratio = row.visible / (row.size * row.size);
    if (ratio < 0.02 || ratio > 0.8) {
      failures.push(`the ${row.size}px mark has implausible visible-pixel ratio ${ratio}`);
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error("FAIL  verify:logo");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:logo  (${geometries.length} shared paths, ${compactShapes.length} compact shapes, 4 raster sizes, 1 icon generator)`,
);
