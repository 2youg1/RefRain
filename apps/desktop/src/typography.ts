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

export function applyTypography(root: HTMLElement, typography: TypographyConfig): void {
  const projection = typographyProjection(typography, measureFontLine(typography));
  root.dataset.baselineGrid = projection.dataset.baselineGrid;
  for (const [property, value] of Object.entries(projection.properties)) {
    root.style.setProperty(property, value);
  }
}
