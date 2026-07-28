import type { Lang } from "./i18n.ts";
import { loadBindings, saveBindings } from "./keys.ts";
import { DEFAULTS, manuscriptStack, type TypeSettings } from "./typography.ts";

/**
 * Settings that outlive a session.
 *
 * Pulled out of the shell component because they answer a different question
 * from anything on screen: not "what is the author looking at" but "what did
 * the author choose, once, and expect to still hold tomorrow". Keeping them
 * together also puts every `localStorage` key in one file, which is where you
 * want them when a key has to be renamed or migrated.
 */

/**
 * Eight themes, each belonging to a time of day (see themes.css).
 *
 * Day and night are not one palette and its inverse: inverting a day palette
 * gives a screen turned inside out, not a page under a lamp. So the five day
 * themes and the three night themes are drawn separately, and switching between
 * them is a change of hour rather than a change of polarity.
 */
export type Theme = "tou" | "kasumi" | "kare" | "hayashi" | "seiji" | "sumi" | "yu" | "shigure";

export const THEMES: readonly { id: Theme; label: `theme.${Theme}`; mode: "day" | "night" }[] = [
  { id: "tou", label: "theme.tou", mode: "day" },
  { id: "kasumi", label: "theme.kasumi", mode: "day" },
  { id: "kare", label: "theme.kare", mode: "day" },
  { id: "hayashi", label: "theme.hayashi", mode: "day" },
  { id: "seiji", label: "theme.seiji", mode: "day" },
  { id: "sumi", label: "theme.sumi", mode: "night" },
  { id: "yu", label: "theme.yu", mode: "night" },
  { id: "shigure", label: "theme.shigure", mode: "night" },
];
/**
 * How much sits between the author and what is behind the window.
 *
 * Four distances on one image — a wet day seen from indoors. 晴 is not looking
 * out; 靄 is through vapour; 傘 is from under a clear umbrella; 硝子 is
 * through the glass, clearest and furthest.
 */
export type Surface = "sei" | "moya" | "kasa" | "garasu";

/**
 * The four steps in order, so the settings panel renders them rather than
 * re-listing them. Re-listing is how the panel came to offer three options
 * while this file declared four.
 */
export const SURFACES: readonly { id: Surface; label: `set.${Surface}` }[] = [
  { id: "sei", label: "set.sei" },
  { id: "moya", label: "set.moya" },
  { id: "kasa", label: "set.kasa" },
  { id: "garasu", label: "set.garasu" },
];
export type SheetStyle = "none" | "hairline" | "paper";
export type Layout = "page" | "canvas";

export interface Preferences {
  lang: Lang;
  theme: Theme;
  surface: Surface;
  sheet: SheetStyle;
  layout: Layout;
  icon: string | null;
  type: TypeSettings;
  bindings: Record<string, string>;
  roots: string[];
}

const KEY = {
  lang: "refrain.lang",
  theme: "refrain.theme",
  surface: "refrain.surface",
  sheet: "refrain.sheet",
  layout: "refrain.layout",
  icon: "refrain.icon",
  type: "refrain.type",
  roots: "refrain.roots",
} as const;

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // A corrupt value is not worth crashing over; the default is always safe.
    return fallback;
  }
};

/**
 * Valid JSON is not a valid value.
 *
 * `read` returns whatever parsed, cast to the declared type, so a theme name
 * retired two versions ago still reached `data-theme` and left the interface
 * on a palette no stylesheet answered to. Anything stored as one of a fixed
 * set of names has to be checked against that set on the way in.
 */
const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  const stored = read<unknown>(key, fallback);
  return allowed.includes(stored as T) ? (stored as T) : fallback;
};

export const loadPreferences = (): Preferences => ({
  lang: oneOf<Lang>(KEY.lang, ["zh", "en"], "zh"),
  theme: oneOf<Theme>(
    KEY.theme,
    THEMES.map((entry) => entry.id),
    "tou",
  ),
  surface: oneOf<Surface>(
    KEY.surface,
    SURFACES.map((step) => step.id),
    "sei",
  ),
  sheet: oneOf<SheetStyle>(KEY.sheet, ["none", "hairline", "paper"], "none"),
  layout: oneOf<Layout>(KEY.layout, ["page", "canvas"], "page"),
  icon: read<string | null>(KEY.icon, null),
  type: { ...DEFAULTS, ...read<TypeSettings>(KEY.type, DEFAULTS) },
  bindings: loadBindings(),
  roots: read<string[]>(KEY.roots, []),
});

export const persist = <K extends keyof typeof KEY>(key: K, value: Preferences[K]): void => {
  localStorage.setItem(KEY[key], JSON.stringify(value));
};

export const persistBindings = saveBindings;

/**
 * Push the manuscript's typography into CSS custom properties.
 *
 * `--column-width` is computed here as an absolute length rather than left as
 * `em`: em resolves against whichever element reads it, so the header at one
 * font size and the manuscript at another produced two different widths from
 * one variable — and centring them produced two different left edges.
 */
export const applyTypography = (type: TypeSettings, fontLine: number): void => {
  const style = document.documentElement.style;

  style.setProperty("--manuscript-family", manuscriptStack(type));
  style.setProperty("--manuscript-size", `${type.size * type.zoom}px`);
  style.setProperty("--manuscript-weight", String(type.weight));
  style.setProperty("--manuscript-leading", String(type.leading));
  style.setProperty("--manuscript-tracking", `${type.tracking}em`);
  style.setProperty("--manuscript-word-spacing", `${type.wordSpacing}em`);
  style.setProperty("--manuscript-measure", `${type.measure}em`);
  style.setProperty("--manuscript-indent", `${type.indent}em`);
  style.setProperty("--manuscript-align", type.align);
  style.setProperty("--paragraph-spacing", String(type.paragraphSpacing));
  style.setProperty("--margin-top", `${type.marginTop}rem`);
  style.setProperty("--margin-bottom", `${type.marginBottom}vh`);
  style.setProperty("--grid-every", String(type.gridEvery));
  style.setProperty("--column-width", `${type.measure * type.size * type.zoom + 144}px`);
  style.setProperty("--font-line", fontLine.toFixed(4));
};

export const applyAppearance = (theme: Theme, surface: Surface, sheet: SheetStyle): void => {
  const root = document.documentElement.dataset;
  root.theme = theme;
  root.surface = surface;
  root.sheet = sheet;
};
