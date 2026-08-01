import { manuscriptStack } from "./fonts";
import type { TypographyConfig } from "./generated/bindings.gen";

export interface TypographyProjection {
  readonly dataset: { readonly baselineGrid: "on" | "off" };
  readonly properties: Readonly<Record<string, string>>;
}

const decimal = (value: number, places = 3): string =>
  Number.parseFloat(value.toFixed(places)).toString();

const effectiveSize = (typography: TypographyConfig): number =>
  (typography.text_size_tenths_px / 10) * (typography.zoom_percent / 100);

/** One complete Config value becomes one complete manuscript projection. */
export function typographyProjection(
  typography: TypographyConfig,
  fontLine: number,
): TypographyProjection {
  const size = effectiveSize(typography);
  const leading = typography.line_height_percent / 100;
  const paragraphSpacing = typography.paragraph_spacing_percent / 100;
  const gridEvery = Math.max(1, typography.baseline_grid_lines);
  const lineBox = size * leading;
  const ruleAt = (lineBox + size * fontLine) / 2;
  return {
    dataset: { baselineGrid: typography.baseline_grid_lines === 0 ? "off" : "on" },
    properties: {
      "--manuscript-family": manuscriptStack(typography.fonts),
      "--manuscript-size": `${decimal(size)}px`,
      "--manuscript-weight": String(typography.font_weight),
      "--manuscript-leading": decimal(leading),
      "--manuscript-tracking": `${decimal(typography.letter_spacing_thousandths_em / 1000)}em`,
      "--manuscript-word-spacing": `${decimal(typography.word_spacing_thousandths_em / 1000)}em`,
      "--manuscript-measure": `${decimal(typography.measure_tenths_em / 10)}em`,
      "--manuscript-indent": `${decimal(typography.first_line_indent_tenths_em / 10)}em`,
      "--paragraph-gap": `${decimal(leading * paragraphSpacing)}em`,
      "--manuscript-align": typography.alignment,
      "--page-top-padding": `${decimal(typography.page_top_padding_tenths_rem / 10)}rem`,
      "--page-bottom-padding": `${decimal(typography.page_bottom_padding_tenths_vh / 10)}vh`,
      "--rule-at": `${decimal(ruleAt)}px`,
      "--grid-period": `${decimal(lineBox * gridEvery)}px`,
    },
  };
}

/** Measure the active stack instead of assuming one ascent/descent ratio. */
export function measureFontLine(typography: TypographyConfig): number {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return 1.16;
  const size = effectiveSize(typography);
  context.font = `${typography.font_weight} ${size}px ${manuscriptStack(typography.fonts)}`;
  const metrics = context.measureText("字Hg");
  const ratio = (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) / size;
  return Number.isFinite(ratio) && ratio >= 0.8 && ratio <= 1.8 ? ratio : 1.16;
}

/**
 * 把排版投影写到根元素上，并在内嵌字体真正就绪后**再量一次**。
 *
 * ## 为什么必须量两次
 *
 * `@font-face` 是惰性的：字体文件在第一次真正用到之前不下载。而
 * `measureFontLine` 用 canvas 量 ascent/descent，字体没到位时它量的是
 * **fallback 的度量**——不报错、不抛异常，只是给出一个属于别的字体的数字。
 * 那个数字进了 `--rule-at` 与 `--grid-period`，基线网格就画在错的位置上。
 *
 * 本机实测（Chromium，真实内嵌 woff2）：同一套字体栈在 `document.fonts.load()`
 * 之前量得 **1.10**，之后量得 **1.11**。差值不大，但它是**确定错的**，
 * 而且随字体而变——换一套字重差别更大的字体就会明显起来。
 *
 * 交接文件记着这条「本机无法验证」，实际是可验证的：早先的探针拿 fallback
 * 与内嵌字体比，两者对 CJK 恰好同族度量，于是量到相同数字并读作「无法证明」。
 * **量不出差异时先问对照组是不是同一个东西**，而不是断定问题不存在。
 *
 * ## 为什么是 `document.fonts.ready` 而不是 `check()`
 *
 * `check()` 回答「这个 family 现在可用吗」，而它在字体尚未下载时也可能返回
 * true（实测本机两个时刻都是 true）——它问的是「有没有匹配的 face 声明」，
 * 不是「字节到了没有」。`load()` 才真的触发下载，`ready` 才真的等它完成。
 *
 * 首次同步量一次是必要的：等字体的那几十毫秒里页面已经要显示，用 fallback
 * 度量先排一版总好过空白。字体到位后重排一次，作者看到的是一次轻微的调整，
 * 而不是一直用着错的网格。
 */
export function applyTypography(root: HTMLElement, typography: TypographyConfig): void {
  const project = (): void => {
    const projection = typographyProjection(typography, measureFontLine(typography));
    root.dataset.baselineGrid = projection.dataset.baselineGrid;
    for (const [property, value] of Object.entries(projection.properties)) {
      root.style.setProperty(property, value);
    }
  };

  project();

  // `document.fonts` 在极老的运行时里可能缺席；缺席时首次那一版就是最终版。
  const fonts = root.ownerDocument.fonts;
  if (fonts === undefined) return;

  const size = effectiveSize(typography);
  const stack = manuscriptStack(typography.fonts);
  // 量什么字符就 load 什么字符：`load()` 的第二个参数决定下载哪些字形，
  // 而 `measureFontLine` 量的正是「字Hg」——中西各一，两族都得到位。
  void Promise.all([
    fonts.load(`${typography.font_weight} ${size}px ${stack}`, "字Hg"),
    fonts.ready,
  ])
    .then(project)
    .catch(() => {
      // 字体没能加载不是错误：fallback 度量仍然可用，首次那一版继续有效。
    });
}
