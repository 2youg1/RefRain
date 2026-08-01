// 手稿字体栈必须总能画出汉字与假名。
// Han 槽可以指向缺失字体或仅含拉丁字母的字体，因此栈末尾必须有随包兜底。
// 而不是取决于默认值长什么样。
//
// 所以这道门禁问的是最不利的情况：**三个槽全是不存在的字体名**，栈还能不能
// 画出汉字与假名，且画出来的不是豆腐块。
//
// 判据是像素而非 `document.fonts.check`：后者回答「这个 family 加载了吗」，
// 而作者看到的是屏幕上有没有字。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { ensureNodeDriver } from "./pw-chromium.ts";

ensureNodeDriver(import.meta.url);

const FONT_DIR = "apps/desktop/src/fonts";
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const bundled = [
  { family: "Noto Sans SC", file: "NotoSansSC-Regular.woff2" },
  { family: "Zen Kaku Gothic New", file: "ZenKakuGothicNew-Regular.woff2" },
];

const faces = bundled
  .map(
    ({ family, file }) =>
      `@font-face { font-family: "${family}"; src: url("/fonts/${file}") format("woff2"); }`,
  )
  .join("\n");

// 作者把三个槽都填成不存在的字体：最不利，但完全合法。
const { manuscriptStack } = await import("../apps/desktop/src/fonts.ts");
const stack = manuscriptStack({
  latin: "No Such Latin Face",
  chinese: "No Such Han Face",
  japanese: "No Such Kana Face",
  priority: ["latin", "chinese", "japanese"],
});

const html = `<!doctype html>
<meta charset="utf-8">
<style>
${faces}
html, body { margin: 0; background: white; }
span { display: inline-block; padding: 8px; color: black; font-size: 72px; line-height: 1.2; }
</style>
<span id="han">直骨令</span>
<span id="kana">ひらがな</span>
<span id="blank">　　　</span>`;

interface GlyphState {
  readonly rendered: boolean;
  readonly han: string;
  readonly kana: string;
  readonly blank: string;
}

async function renderOnce(): Promise<GlyphState> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({
    viewport: { width: 900, height: 300 },
    deviceScaleFactor: 1,
  });
  await page.route("http://refrain.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      await route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
      return;
    }
    const name = path.replace("/fonts/", "");
    if (!bundled.some((entry) => entry.file === name)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({
      body: await readFile(`${FONT_DIR}/${name}`),
      contentType: "font/woff2",
    });
  });

  try {
    await page.goto("http://refrain.test/");
    await page.evaluate(async (family) => {
      for (const element of document.querySelectorAll("span")) {
        (element as HTMLElement).style.fontFamily = family;
      }
      await document.fonts.ready;
    }, stack);

    // Sample until two consecutive frames satisfy the pixel contract. A loaded
    // FontFace can become ready before headless Chromium has committed its first
    // glyph paint under CPU pressure. Persistent missing glyphs still fail after
    // one second; only the transient blank-frame state receives another frame.
    const shotOf = async (id: string) => sha256(await page.locator(`#${id}`).screenshot());
    let han = "";
    let kana = "";
    let blank = "";
    let previousValidState: string | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      han = await shotOf("han");
      kana = await shotOf("kana");
      blank = await shotOf("blank");
      const valid = han !== blank && kana !== blank && han !== kana;
      const state = `${han}:${kana}:${blank}`;
      if (valid && state === previousValidState) return { rendered: true, han, kana, blank };
      previousValidState = valid ? state : null;
      await page.waitForTimeout(50);
    }
    return { rendered: false, han, kana, blank };
  } finally {
    await browser.close();
  }
}

const failures: string[] = [];
if (!stack.includes("Noto Sans SC") || !stack.includes("Zen Kaku Gothic New")) {
  failures.push(`the stack drops its bundled fallbacks: ${stack}`);
}

// A wholly blank browser session is a fixture failure seen after many Chromium
// launches in one WSL process namespace. Start one fresh session; never relax
// the pixel predicate. A stable product defect returns the same red result.
let glyphs = await renderOnce();
if (!glyphs.rendered) glyphs = await renderOnce();
if (!glyphs.rendered) {
  if (glyphs.han === glyphs.blank) {
    failures.push("Han rendered as nothing: the stack has no face that carries it");
  }
  if (glyphs.kana === glyphs.blank) {
    failures.push("kana rendered as nothing: the stack has no face that carries it");
  }
  if (glyphs.han === glyphs.kana) {
    failures.push("Han and kana produced identical pixels; the render is not measuring glyphs");
  }
  if (failures.length === 0) {
    failures.push("glyph pixels did not stabilise in two consecutive frames within two sessions");
  }
}

if (failures.length > 0) {
  console.error(`FAIL  verify:font-fallback\n      ${failures.join("\n      ")}`);
  process.exit(1);
}
console.log(
  "PASS  verify:font-fallback  (Han and kana still render when every configured face is missing)",
);
