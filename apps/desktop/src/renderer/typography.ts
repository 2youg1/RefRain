/**
 * The manuscript's typographic settings.
 *
 * Kept in a module rather than the component because a Svelte file cannot
 * export runtime values, and because these belong to the document rather than
 * to the panel that edits them.
 *
 * Units are the ones typographers use — points for size, multiples of the size
 * for leading, ems for tracking — rather than the pixels a browser works in.
 */
export interface TypeSettings {
  family: "serif" | "sans" | "mono" | "display" | "custom";
  customFamily: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
  wordSpacing: number;
  measure: number;
  indent: number;
  paragraphSpacing: number;
  align: "left" | "justify";
  marginTop: number;
  marginBottom: number;
  grid: boolean;
  gridEvery: number;
}

export const DEFAULTS: TypeSettings = {
  family: "serif",
  customFamily: "",
  size: 17,
  weight: 400,
  leading: 1.95,
  tracking: 0.01,
  wordSpacing: 0,
  measure: 34,
  indent: 0,
  paragraphSpacing: 1,
  align: "left",
  marginTop: 3,
  marginBottom: 50,
  grid: false,
  gridEvery: 1,
};

/**
 * Measure a typeface's own line height instead of assuming a ratio.
 *
 * The baseline grid draws its rule one pixel under the glyphs, which sits at
 * half-leading plus the font's ascent and descent. That last quantity differs
 * per face — Chiron Sung HK and Jost do not agree — so assuming a constant is
 * what put the rule through the middle of the characters.
 */
export const measureFontLine = (family: string, size: number): number => {
  const probe = document.createElement("span");
  probe.textContent = "字Hg";
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;font-family:${family};font-size:${size}px`;
  document.body.append(probe);
  const ratio = probe.getBoundingClientRect().height / size;
  probe.remove();
  return ratio;
};
