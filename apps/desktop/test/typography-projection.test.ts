import { describe, expect, test } from "bun:test";
import type { TypographyConfig } from "../src/generated/bindings.gen";
import { typographyProjection } from "../src/typography";

const typography: TypographyConfig = {
  fonts: {
    latin: "Jost",
    chinese: "Noto Sans SC",
    japanese: "Murecho",
    priority: ["japanese", "chinese", "latin"],
  },
  text_size_tenths_px: 215,
  font_weight: 520,
  line_height_percent: 225,
  letter_spacing_thousandths_em: 25,
  word_spacing_thousandths_em: 100,
  measure_tenths_em: 420,
  first_line_indent_tenths_em: 20,
  paragraph_spacing_percent: 125,
  alignment: "justify",
  page_top_padding_tenths_rem: 45,
  page_bottom_padding_tenths_vh: 350,
  baseline_grid_lines: 2,
  zoom_percent: 115,
};

describe("typography projection", () => {
  test("one complete config projects every manuscript material", () => {
    const projection = typographyProjection(typography, 1.18);

    expect(projection.dataset).toEqual({ baselineGrid: "on" });
    expect(projection.properties).toEqual({
      // 栈末尾总有随包兜底（fonts.ts）：作者选的字体缺字或不存在时仍画得出汉字与假名。
      "--manuscript-family": '"Murecho", "Noto Sans SC", "Jost", "Zen Kaku Gothic New", serif',
      "--manuscript-size": "24.725px",
      "--manuscript-weight": "520",
      "--manuscript-leading": "2.25",
      "--manuscript-tracking": "0.025em",
      "--manuscript-word-spacing": "0.1em",
      "--manuscript-measure": "42em",
      "--manuscript-indent": "2em",
      "--paragraph-spacing": "1.25",
      "--paragraph-gap": "2.813em",
      "--manuscript-align": "justify",
      "--page-top-padding": "4.5rem",
      "--page-bottom-padding": "35vh",
      "--grid-every": "2",
      "--line-box": "55.631px",
      "--rule-at": "42.403px",
      "--grid-period": "111.262px",
      "--font-line": "1.18",
    });
  });

  test("zero baseline lines disables the grid without emitting an invalid period", () => {
    const projection = typographyProjection({ ...typography, baseline_grid_lines: 0 }, 1.18);

    expect(projection.dataset.baselineGrid).toBe("off");
    expect(projection.properties["--grid-every"]).toBe("1");
  });
});
