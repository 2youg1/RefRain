// 手稿字体栈必须总能画出汉字与假名。
//
// KL9 的要求是「确保打开软件不出现显示错误」。Han 现在默认来自作者本机，
// 而作者可以把三个槽改成任何名字——包括机器上根本不存在的字体、或一个只有
// 拉丁字母的字体。那时候能不能画出字，取决于**栈末尾是否总有随包的兜底**，
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

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 300 }, deviceScaleFactor: 1 });
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

const failures: string[] = [];
try {
  await page.goto("http://refrain.test/");
  await page.evaluate(async (family) => {
    for (const element of document.querySelectorAll("span")) {
      (element as HTMLElement).style.fontFamily = family;
    }
    await document.fonts.ready;
  }, stack);

  if (!stack.includes("Noto Sans SC") || !stack.includes("Zen Kaku Gothic New")) {
    failures.push(`the stack drops its bundled fallbacks: ${stack}`);
  }

  // 三块像素：汉字、假名，以及一块只有全角空格的对照。
  // 若汉字那块与空白块相同，说明什么也没画出来——豆腐块或空白。
  const shotOf = async (id: string) => sha256(await page.locator(`#${id}`).screenshot());
  const han = await shotOf("han");
  const kana = await shotOf("kana");
  const blank = await shotOf("blank");

  if (han === blank) {
    failures.push("Han rendered as nothing: the stack has no face that carries it");
  }
  if (kana === blank) {
    failures.push("kana rendered as nothing: the stack has no face that carries it");
  }
  if (han === kana) {
    failures.push("Han and kana produced identical pixels; the render is not measuring glyphs");
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`FAIL  verify:font-fallback\n      ${failures.join("\n      ")}`);
  process.exit(1);
}
console.log(
  "PASS  verify:font-fallback  (Han and kana still render when every configured face is missing)",
);
