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
  // Mincho, not gothic: Japanese body text is set in mincho, and the slot had
  // only ever offered a gothic — the equivalent of defaulting Latin prose to a
  // grotesque display face.
  jpFamily: "Shippori Mincho",
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

/**
 * The faces this application ships, always present regardless of the machine.
 *
 * Murecho left the Chinese list. It is a Japanese sans, and offering it as a
 * Chinese option put a reader one click away from seeing their own characters
 * in the other tradition's shapes — 直, 骨 and 令 among them.
 *
 * Japanese now has a mincho as well as a gothic, because Japanese body text is
 * set in mincho: a gothic there is a display face, the way a grotesque is in
 * Latin, and the slot had only ever held one.
 */
export const BUNDLED_CJK = ["Chiron Sung HK", "Noto Sans SC"];
export const BUNDLED_JP = ["Shippori Mincho", "Zen Kaku Gothic New", "Murecho"];
export const BUNDLED_LATIN = ["Antic Didone", "Jost", "Courier Prime"];

/**
 * The manuscript's font stack — the single authority for that question.
 *
 * Latin, then Japanese, then Chinese, then a generic. Order is the whole
 * mechanism: a browser walks the stack per character and takes the first face
 * that has a glyph for it. Latin leads because the CJK faces also carry Latin.
 * Japanese precedes Chinese because 直, 骨 and 令 exist in both and are drawn
 * differently, so a writer quoting Japanese inside Chinese prose needs the
 * kana-bearing face first.
 *
 * This exists because the stack was being written out twice — once to render
 * (`applyTypography`) and once to measure the baseline grid — and the two
 * copies disagreed. The measuring copy read `"latin", "cjk", serif` and had no
 * `jp` slot at all, so on a manuscript set in Japanese the grid was measured
 * against a face the text was not rendered in. `measureFontLine` returns the
 * face's own ascent-plus-descent ratio, and Shippori Mincho does not agree
 * with Chiron Sung HK about it; the rule was therefore drawn through the
 * middle of the characters — the exact defect `measureFontLine` was written to
 * prevent. Two expressions of one fact is one too many.
 *
 * Empty slots are dropped rather than quoted-empty: `""` is a parse error that
 * discards the whole declaration. Each name is quoted, because a multi-word
 * family unquoted is the same error. A name carrying a quote, a backslash or a
 * semicolon is dropped entirely rather than escaped: the author's font library
 * is not a trusted source of CSS, and no real family carries any of them.
 */
export const manuscriptStack = (type: {
  latinFamily: string;
  jpFamily: string;
  cjkFamily: string;
}): string =>
  [
    ...[type.latinFamily, type.jpFamily, type.cjkFamily]
      .filter((name) => name.trim().length > 0 && !/["'\\;]/.test(name))
      .map((name) => `"${name}"`),
    "serif",
  ].join(", ");

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
