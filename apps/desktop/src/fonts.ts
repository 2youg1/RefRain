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
  const parts = fonts.priority
    .map((slot) => names[slot])
    .map(safe)
    .filter((name): name is string => name !== null);
  parts.push("serif");
  return parts.join(", ");
};
