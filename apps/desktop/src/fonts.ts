/**
 * The manuscript's font stack, built from the Config's three slots
 * (SPEC 9.8). Order is the whole mechanism: the browser walks the stack per
 * character and the first face carrying the glyph wins, so `priority`
 * decides which tradition draws shared Han. A name carrying a quote, a
 * backslash, or a semicolon is dropped entirely rather than escaped: the
 * author's font library is not a trusted source of CSS.
 */

export type FontSlot = "latin" | "chinese" | "japanese";

export interface FontConfig {
  latin: string;
  chinese: string;
  japanese: string;
  priority: FontSlot[];
}

/**
 * The bundled fallbacks, always last in the stack.
 *
 * Han comes from the author's own machine by default, and the author may name
 * any face they have installed — including one that does not exist, or one
 * that carries no Han at all. Appending these two makes "the manuscript never
 * shows tofu" a property of the stack rather than a property of the default
 * value, which the author is free to change.
 *
 * Noto Sans SC carries 20,976 Han and both kana; Zen Kaku Gothic New carries
 * Japanese with kana-native shaping. Generic `serif` remains after them for
 * scripts neither covers.
 */
const BUNDLED_FALLBACKS = ['"Noto Sans SC"', '"Zen Kaku Gothic New"', "serif"] as const;

const safe = (name: string): string | null =>
  name.trim().length > 0 && !/["'\\;]/.test(name) ? `"${name}"` : null;

/** The single authority for the manuscript's stack (SPEC 9.10: one authority
 * per fact — the editor reads this and nothing else). */
export const manuscriptStack = (fonts: FontConfig): string => {
  const names: Record<FontSlot, string> = {
    latin: fonts.latin,
    chinese: fonts.chinese,
    japanese: fonts.japanese,
  };
  const chosen = fonts.priority
    .map((slot) => names[slot])
    .map(safe)
    .filter((name): name is string => name !== null);
  // A bundled fallback the author already named stays where they put it.
  const parts = [...chosen, ...BUNDLED_FALLBACKS.filter((name) => !chosen.includes(name))];
  return parts.join(", ");
};
