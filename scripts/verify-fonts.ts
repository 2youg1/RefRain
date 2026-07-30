#!/usr/bin/env bun

import { basename } from "node:path";
import { chromium } from "playwright";
import { type FontConfig, manuscriptStack } from "../apps/desktop/src/fonts";

const sourceRoot = "apps/desktop/src/fonts";
const distRoot = "apps/desktop/dist";
const sources = [
  "NotoSansSC-Regular.woff2",
  "ZenKakuGothicNew-Regular.woff2",
  "AnticDidone.woff2",
  "Jost.woff2",
  "CourierPrime.woff2",
] as const;

const sha256 = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
};

const bytesAt = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(path).arrayBuffer());

const build = Bun.spawnSync(["bun", "run", "build:web"], { stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) {
  console.error(new TextDecoder().decode(build.stderr));
  process.exit(build.exitCode);
}

const emitted = [...new Bun.Glob("assets/*.woff2").scanSync({ cwd: distRoot })];
const byteFailures: string[] = [];
const sourceByRoute = new Map<string, string>();
const sourceDigests = new Set<string>();
for (const file of sources) {
  const sourcePath = `${sourceRoot}/${file}`;
  const stem = basename(file, ".woff2");
  const candidates = emitted.filter((path) => basename(path).startsWith(`${stem}-`));
  if (candidates.length !== 1) {
    byteFailures.push(`${file}: expected one emitted asset, found ${candidates.length}`);
    continue;
  }
  const sourceBytes = await bytesAt(sourcePath);
  const emittedBytes = await bytesAt(`${distRoot}/${candidates[0]}`);
  const sourceDigest = sha256(sourceBytes);
  sourceDigests.add(sourceDigest);
  if (sha256(emittedBytes) !== sourceDigest) byteFailures.push(`${file}: emitted bytes drifted`);
  sourceByRoute.set(`/fonts/${file}`, sourcePath);
}
if (sourceDigests.size !== sources.length)
  byteFailures.push("two bundled family names share one binary");
if (byteFailures.length > 0) {
  console.error("FAIL  verify:fonts");
  for (const failure of byteFailures) console.error(`      ${failure}`);
  process.exit(1);
}

const families: FontConfig = {
  latin: "Antic Didone",
  chinese: "Noto Sans SC",
  japanese: "Zen Kaku Gothic New",
  priority: ["latin", "chinese", "japanese"],
};
const chineseFirst = manuscriptStack({
  ...families,
  priority: ["chinese", "japanese", "latin"],
});
const japaneseFirst = manuscriptStack({
  ...families,
  priority: ["japanese", "chinese", "latin"],
});
const html = `<!doctype html>
<meta charset="utf-8">
<style>
@font-face { font-family: "Noto Sans SC"; src: url("/fonts/NotoSansSC-Regular.woff2") format("woff2"); }
@font-face { font-family: "Zen Kaku Gothic New"; src: url("/fonts/ZenKakuGothicNew-Regular.woff2") format("woff2"); }
html, body { margin: 0; background: white; }
#sentinel { display: inline-block; padding: 8px; color: black; font-size: 72px; line-height: 1.2; }
</style>
<span id="sentinel">直骨令</span>`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 640, height: 180 }, deviceScaleFactor: 1 });
await page.route("http://refrain.test/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/") {
    await route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
    return;
  }
  const source = sourceByRoute.get(path);
  if (!source) {
    await route.abort("blockedbyclient");
    return;
  }
  await route.fulfill({ body: Buffer.from(await bytesAt(source)), contentType: "font/woff2" });
});

try {
  await page.goto("http://refrain.test/");
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('72px "Noto Sans SC"', "直骨令"),
      document.fonts.load('72px "Zen Kaku Gothic New"', "直骨令"),
    ]);
    await document.fonts.ready;
  });
  const sentinel = page.locator("#sentinel");
  const render = async (stack: string): Promise<string> => {
    await sentinel.evaluate((element, family) => {
      (element as HTMLElement).style.fontFamily = family;
    }, stack);
    return sha256(await sentinel.screenshot({ animations: "disabled" }));
  };

  const chineseDirect = await render('"Noto Sans SC"');
  const chineseStack = await render(chineseFirst);
  const japaneseDirect = await render('"Zen Kaku Gothic New"');
  const japaneseStack = await render(japaneseFirst);
  const pixelFailures: string[] = [];
  if (chineseStack !== chineseDirect)
    pixelFailures.push("Chinese-first stack does not draw the Chinese face");
  if (japaneseStack !== japaneseDirect)
    pixelFailures.push("Japanese-first stack does not draw the Japanese face");
  if (chineseStack === japaneseStack)
    pixelFailures.push("changing CJK priority does not change sentinel pixels");
  if (pixelFailures.length > 0) {
    console.error("FAIL  verify:fonts");
    for (const failure of pixelFailures) console.error(`      ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS  verify:fonts  (${sources.length} source/emitted byte pairs, 4 sentinel renders, priority changes pixels)`,
    );
  }
} finally {
  await browser.close();
}
