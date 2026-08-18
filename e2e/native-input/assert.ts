#!/usr/bin/env bun
/**
 * 真输入通道的裁定。
 *
 * **接上哪个功能**：`drive-windows.ps1` 走完一遍真点击与真和弦之后,这里判它
 * 留下的证据算不算数。
 *
 * **在全局逻辑中负责什么**：只判**可机检的事实**——文件里有没有那几个字、和弦
 * 有没有把命令送到、画面上有没有墨、换主题之后纸色是不是真的变了。好不好看不
 * 归这里。
 *
 * **为什么画面证据不能是哈希**：`e2e/ime` 的清单记两张截图的 SHA-256 并要求它们
 * 不同。一张全黑的图哈希同样稳定,两张不同的全黑图哈希同样不同——哈希证明不了
 * 屏幕上画过任何东西。所以这里解像素:纸面得是纸色,正稿区得有墨,换主题之后
 * 那一片纸色得离原来的纸色足够远。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, distance, hex, type Rgb, type Surface } from "../../scripts/png-pixels.ts";

const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};
const root = flag("--root", process.cwd());
const manifestPath = join(root, flag("--manifest", "e2e/native-input/results/windows/run.json"));

interface Manifest {
  readonly platform: string;
  readonly documentPath: string;
  readonly input: {
    readonly source: string;
    readonly clicks: readonly { readonly what: string }[];
    readonly typedText: string;
    readonly chordsPressed: readonly string[];
  };
  readonly observed: {
    readonly savedText: string;
    readonly originalText: string;
    readonly exitedOnChord: boolean;
    readonly exitCode: number;
  };
  readonly manuscript: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly snapshots: Readonly<Record<string, string>>;
  readonly screenshots: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const failures: string[] = [];
const notes: string[] = [];

const read = (relative: string): string => readFileSync(join(root, relative), "utf8");
const surfaceOf = (relative: string): Surface => decodePng(readFileSync(join(root, relative)));

/**
 * 一片区域里离参考色足够远的像素占比。
 *
 * 「有墨」就是这个:纸上写了字的地方,像素离纸色远。用占比而不是计数,判据才不
 * 随窗口大小改变;用距离而不是「是不是黑」,判据才不随主题改变。
 */
function fractionFar(
  surface: Surface,
  reference: Rgb,
  threshold: number,
  region: { x: number; y: number; width: number; height: number },
): number {
  let far = 0;
  let counted = 0;
  for (let y = region.y; y < region.y + region.height; y += 2) {
    for (let x = region.x; x < region.x + region.width; x += 2) {
      const pixel = surface.at(x, y);
      if (!pixel) continue;
      counted += 1;
      if (distance(pixel, reference) > threshold) far += 1;
    }
  }
  return counted === 0 ? 0 : far / counted;
}

/** 一片区域里出现最多的颜色。纸色就是这样问出来的,而不是硬写一个值。 */
function dominantColour(
  surface: Surface,
  region: { x: number; y: number; width: number; height: number },
): Rgb {
  const tally = new Map<string, { colour: Rgb; count: number }>();
  for (let y = region.y; y < region.y + region.height; y += 2) {
    for (let x = region.x; x < region.x + region.width; x += 2) {
      const pixel = surface.at(x, y);
      if (!pixel) continue;
      const key = hex(pixel);
      const seen = tally.get(key);
      if (seen) seen.count += 1;
      else tally.set(key, { colour: pixel, count: 1 });
    }
  }
  let best: Rgb = { r: 0, g: 0, b: 0 };
  let bestCount = -1;
  for (const entry of tally.values()) {
    if (entry.count > bestCount) {
      best = entry.colour;
      bestCount = entry.count;
    }
  }
  return best;
}

const check = (ok: boolean, failure: string, note: string): void => {
  if (ok) notes.push(note);
  else failures.push(failure);
};

// —— 输入必须真的来自 OS ——
check(
  manifest.input.source === "os",
  `the lane recorded input source "${manifest.input.source}", not "os"`,
  "input source is the OS",
);
check(
  manifest.input.clicks.length >= 2,
  "the lane recorded fewer than two real clicks",
  `${manifest.input.clicks.length} real clicks at accessibility-reported coordinates`,
);

// —— 真点击必须真的改变了界面 ——
// 采纳与打开都是点出来的:树里长出文档行、正稿框上台,这两件事是点击落到了实处
// 的证据。点空了的话快照等不到它们,驱动早就抛错了——这里把那份证据落成文字。
const adopted = read(manifest.snapshots.adopted ?? "");
const opened = read(manifest.snapshots.opened ?? "");
check(
  /role=treeitem name="document\.md"/u.test(adopted),
  "the real click on 打开一个项目文件夹 did not produce the document row",
  "a real click adopted the project folder",
);
check(
  /role=textbox name="RefRain manuscript"/u.test(opened),
  "the real click on the document row did not open the manuscript",
  "a real click opened the manuscript",
);
const focused = read(manifest.snapshots.focused ?? "");
check(
  /role=textbox name="RefRain manuscript"[^\n]*focused=true/u.test(focused),
  "the real click inside the manuscript did not focus it",
  "a real click focused the manuscript",
);

// —— 真按键必须真的写进了文稿,而落盘是 Ctrl+S 这条和弦的唯一证据 ——
const typed = manifest.input.typedText;
check(
  manifest.observed.savedText.includes(typed),
  `the file on disk does not contain the typed text "${typed}" — real keys or the document.save chord did not land (file holds ${JSON.stringify(manifest.observed.savedText)})`,
  `real keystrokes typed "${typed}" and the document.save chord wrote it to disk`,
);
check(
  manifest.observed.savedText !== manifest.observed.originalText,
  "the file on disk is unchanged, so nothing the lane typed reached it",
  "the manuscript on disk changed",
);

// —— app.quit 的和弦必须真的关掉了应用 ——
check(
  manifest.observed.exitedOnChord,
  "the app.quit chord did not close the application within fifteen seconds",
  "the app.quit chord closed the application",
);
check(
  manifest.observed.exitCode === 0,
  `the application exited with code ${manifest.observed.exitCode} after the app.quit chord`,
  "the application exited cleanly",
);

// —— 画面证据 ——
try {
  const openedShot = surfaceOf(manifest.screenshots.opened ?? "");
  // 取样区就是可访问性树报的正稿矩形，不是猜的比例。比例那一版把区域放在
  // 了第一行字的下方，于是测出 0% 的墨并报「什么都没画」——而字就在那里。
  // 界面结构一变区域跟着变，这是坐标只能有一个权威的意思。
  const bounds = manifest.manuscript;
  const region = {
    x: Math.max(0, bounds.x),
    y: Math.max(0, bounds.y),
    width: Math.min(bounds.width, openedShot.width - Math.max(0, bounds.x)),
    height: Math.min(bounds.height, openedShot.height - Math.max(0, bounds.y)),
  };
  const paper = dominantColour(openedShot, region);
  check(
    distance(paper, { r: 0, g: 0, b: 0 }) > 24,
    `the manuscript area is essentially black (#${hex(paper)}) — the capture shows no rendered window`,
    `the manuscript area is paper #${hex(paper)}`,
  );

  const typedShot = surfaceOf(manifest.screenshots.typed ?? "");
  const ink = fractionFar(typedShot, paper, 40, region);
  check(
    ink > 0.001,
    `the manuscript area carries no ink (${(ink * 100).toFixed(3)}% of pixels differ from the paper) — nothing was drawn`,
    `the manuscript area carries ink on ${(ink * 100).toFixed(2)}% of its pixels`,
  );

  // 换主题这一条的证据只能是像素:命令送到了、模型改了、可访问性树照旧——只有
  // 纸色变了才说明这条和弦一路走到了绘制。
  const before = surfaceOf(manifest.screenshots.themeBefore ?? "");
  const after = surfaceOf(manifest.screenshots.themeAfter ?? "");
  const paperBefore = dominantColour(before, region);
  const paperAfter = dominantColour(after, region);
  const shift = distance(paperBefore, paperAfter);
  check(
    shift > 8,
    `the theme.next chord left the paper at #${hex(paperBefore)} → #${hex(paperAfter)} (distance ${shift.toFixed(1)}) — the chord never reached the painter`,
    `the theme.next chord repainted the paper #${hex(paperBefore)} → #${hex(paperAfter)} (distance ${shift.toFixed(1)})`,
  );
} catch (error) {
  failures.push(`pixel evidence could not be read: ${(error as Error).message}`);
}

for (const note of notes) console.log(`  ok    ${note}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  console.error(
    `FAIL  e2e:input: ${failures.length} of ${failures.length + notes.length} checks failed`,
  );
  process.exit(1);
}
console.log(`PASS  e2e:input: ${notes.length} checks, every one driven by real OS input`);
