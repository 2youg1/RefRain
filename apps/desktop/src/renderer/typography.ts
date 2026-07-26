/**
 * The manuscript's typographic settings.
 *
 * Kept in a module rather than the component because a Svelte file cannot
 * export runtime values, and because these belong to the document rather than
 * to the panel that edits them.
 *
 * Chinese and Latin faces are set separately: a stack that satisfies both at
 * once satisfies neither, and an author who has a favourite Song face rarely
 * wants its bundled Latin companion.
 */
export interface TypeSettings {
  /** Simplified and traditional Chinese. */
  cjkFamily: string;
  /**
   * Japanese, as its own slot (SPEC Q10).
   *
   * One CJK setting cannot serve both traditions: 直, 骨 and 令 are drawn
   * differently, and a face chosen for one renders the other's characters in
   * shapes its reader will call wrong. A writer quoting Japanese inside Chinese
   * prose needs both at once, which a single slot cannot express.
   */
  jpFamily: string;
  latinFamily: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
  wordSpacing: number;
  measure: number;
  /** In characters, the way Chinese typesetting states it. */
  indent: number;
  paragraphSpacing: number;
  align: "left" | "justify";
  marginTop: number;
  marginBottom: number;
  grid: boolean;
  gridEvery: number;
  lineNumbers: boolean;
  /** Dim every paragraph but the one being written. */
  breathe: boolean;
  progress: "gradient" | "solid" | "minimap" | "off";
  progressPlace: "top" | "right";
  zoom: number;
}

export const DEFAULTS: TypeSettings = {
  cjkFamily: "Chiron Sung HK",
  jpFamily: "Zen Kaku Gothic New",
  latinFamily: "Antic Didone",
  size: 17,
  weight: 400,
  leading: 1.95,
  tracking: 0.01,
  wordSpacing: 0,
  measure: 30,
  indent: 0,
  paragraphSpacing: 1,
  align: "left",
  marginTop: 3,
  marginBottom: 50,
  grid: false,
  gridEvery: 1,
  lineNumbers: false,
  breathe: false,
  progress: "gradient",
  progressPlace: "top",
  zoom: 1,
};

/** The faces this application ships, always present regardless of the machine. */
export const BUNDLED_CJK = ["Chiron Sung HK", "Murecho"];
export const BUNDLED_JP = ["Zen Kaku Gothic New", "Murecho"];
export const BUNDLED_LATIN = ["Antic Didone", "Jost", "Courier Prime"];

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

/**
 * Does this machine actually have the face?
 *
 * `document.fonts.check` answers true for any family the system can substitute
 * for, so it cannot detect a fallback. Rendering the same glyph under each
 * family and comparing pixels can: two typefaces cannot produce an identical
 * bitmap.
 */
export const fontIsPresent = (family: string): boolean => {
  const fingerprint = (stack: string): string => {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 48, 48);
    ctx.fillStyle = "#000";
    ctx.font = `36px ${stack}`;
    ctx.textBaseline = "top";
    ctx.fillText("剑Rg", 2, 2);
    return canvas.toDataURL().slice(-80);
  };

  return fingerprint(`"${family}", monospace`) !== fingerprint("monospace");
};
