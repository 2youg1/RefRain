import type { Lang } from "./i18n.ts";
import { loadBindings, saveBindings } from "./keys.ts";
import { DEFAULTS, type TypeSettings } from "./typography.ts";

/**
 * Settings that outlive a session.
 *
 * Pulled out of the shell component because they answer a different question
 * from anything on screen: not "what is the author looking at" but "what did
 * the author choose, once, and expect to still hold tomorrow". Keeping them
 * together also puts every `localStorage` key in one file, which is where you
 * want them when a key has to be renamed or migrated.
 */

export type Theme = "rain" | "kozo" | "ink";
export type Surface = "opaque" | "translucent" | "glass";
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

export const loadPreferences = (): Preferences => ({
  lang: read<Lang>(KEY.lang, "zh"),
  theme: read<Theme>(KEY.theme, "rain"),
  surface: read<Surface>(KEY.surface, "opaque"),
  sheet: read<SheetStyle>(KEY.sheet, "none"),
  layout: read<Layout>(KEY.layout, "page"),
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
  const family = `"${type.latinFamily}", "${type.cjkFamily}", serif`;

  style.setProperty("--manuscript-family", family);
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
