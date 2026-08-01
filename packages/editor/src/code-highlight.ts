/**
 * 代码块的语法高亮。
 *
 * 手稿的正文刻意克制，代码块是唯一的例外：一段代码没有高亮就只是一堆等宽字，
 * 而作者贴进来的代码通常是要给人读的。
 *
 * **每一个 import 都是静态的，这是硬性条件不是风格。** Shiki 的便捷入口
 * （`import { codeToHtml } from "shiki"`）走按需加载，打包后会生成 dynamic chunk，
 * 最坏情况从 CDN 取语法定义——那会直接违反「应用进程零出网」。走 `shiki/core`
 * 精确注册，语言与主题在构建时就被静态解析进产物，运行期不发起任何请求。
 * `verify:no-network` 守着这条边界。
 *
 * 引擎选 JavaScript 而非 Oniguruma WASM：实测 gzip 94KB 对 298KB，语言还多三种，
 * 每块耗时只差 0.06ms，且不必加载 WASM。
 *
 * **配色用 Shiki 的成品主题，不自己从 CSS 变量派生。** TextMate 作用域有数百个，
 * 手写映射只能覆盖其中几个，其余全落到默认前景色；而成品主题是被大量使用者
 * 调校过的。不重新发明一个已经有人做好的东西。
 */

import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import json from "@shikijs/langs/json";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import toml from "@shikijs/langs/toml";
import typescript from "@shikijs/langs/typescript";
import vitesseDark from "@shikijs/themes/vitesse-dark";
import vitesseLight from "@shikijs/themes/vitesse-light";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** 手稿里出现得起的语言。加一种就是加一份体积，所以这张表是有意短的。 */
const LANGS = [bash, css, json, markdown, python, rust, toml, typescript];

/**
 * The two embedded code palettes: one for day, one for night.
 *
 * Vitesse wins because its low-saturation print-like colours sit inside a
 * serif manuscript without shouting, and its dark variant is a true sibling
 * of the light one — switching day/night recolours the fence instead of
 * restyling it. One theme is 3–6 KB; more than two would be weight without
 * a reason (the renderer is reworked in v0.2.3 anyway).
 */
const THEMES = [vitesseLight, vitesseDark];

export type CodeTheme = "vitesse-light" | "vitesse-dark";

/**
 * Resolve the stored preference into one of the two palettes.
 *
 * Config written by older versions may name a retired theme; anything with a
 * dark suffix folds into the night palette, everything else into the day
 * one. With no stored preference the code palette follows the interface
 * theme, so a fence never looks pasted in from another application.
 */
export function normalizeCodeTheme(
  stored: string | null | undefined,
  interfaceTheme: string,
): CodeTheme {
  if (stored !== null && stored !== undefined && stored !== "") {
    return stored.endsWith("-dark") ? "vitesse-dark" : "vitesse-light";
  }
  return codeThemeFor(interfaceTheme);
}

/**
 * 作者没选过代码配色时，按界面主题挑一套。
 *
 * 代码块不该看起来像贴进来的异物：作者在「霞」下打开手稿，代码也该是暖色调的。
 * 这是默认值不是限制——一旦手动选过就尊重选择（存进 Config）。
 */
export function codeThemeFor(interfaceTheme: string): CodeTheme {
  // 夜间两套（墨、韶）配同族的夜间代码配色，切换时不跳色。
  return interfaceTheme === "sumi" || interfaceTheme === "shao" ? "vitesse-dark" : "vitesse-light";
}

/** Shiki 的语言名，含它们各自的别名。用来判断一个围栏标注认不认得。 */
const KNOWN = new Set(
  LANGS.flatMap((lang) => {
    const entries = Array.isArray(lang) ? lang : [lang];
    return entries.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);
  }),
);

let engine: Promise<HighlighterCore> | null = null;

/**
 * 高亮器只造一次。
 *
 * 造它要编译一批正则，做两遍是白花的钱；而第一段代码出现之前一遍都不该做，
 * 所以是懒的，不是启动时就付。
 */
function highlighter(): Promise<HighlighterCore> {
  engine ??= createHighlighterCore({
    langs: LANGS,
    themes: THEMES,
    engine: createJavaScriptRegexEngine(),
  });
  return engine;
}

export function isHighlightable(lang: string): boolean {
  return KNOWN.has(lang.trim().toLowerCase());
}

/**
 * 围栏声明的语言；声明为空或本构建没内嵌它时返回 null。
 *
 * 信息串是开栏反引号之后的整行，其中只有第一个词是语言，其余是别的工具用的
 * 元数据（`rust ignore no_run`）。不认得的语言退化成纯文本——语法定义全部在
 * 构建期内嵌，运行期不会为了一个陌生语言去取任何东西。
 */
export function fenceLanguage(text: string): string | null {
  const breakAt = text.indexOf("\n");
  const firstLine = breakAt === -1 ? text : text.slice(0, breakAt);
  const info = firstLine.replace(/^[`~]+/, "").trim();
  const language = info.split(/\s+/)[0] ?? "";
  return language !== "" && isHighlightable(language) ? language : null;
}

/**
 * 一段着了色的代码。
 *
 * 给的是 token 而不是 HTML 字符串：这个编辑器里 DOM 由 `packages/editor` 独家拥有，
 * 交出一段 HTML 等于给了第二个人往里写节点的权力。调用方拿 token 自己建节点。
 */
export interface CodeToken {
  readonly text: string;
  /** 前景色，来自选定的主题。 */
  readonly color: string;
  /** 斜体等。等宽字体下斜体不改变行高，所以它不会让估高失准。 */
  readonly italic: boolean;
}

/**
 * 已经着过色的结果按「代码 + 语言 + 配色」记住。
 *
 * 滚动来回时同一块会被反复问到，而着色是这条路径上唯一按字符计的开销。
 * 上限按块数计，超出丢最旧的——手稿里代码块本就不多，这个数已经远超一屏。
 */
const CACHE_LIMIT = 500;
const cache = new Map<string, readonly (readonly CodeToken[])[]>();

function remember(key: string, value: readonly (readonly CodeToken[])[]) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export async function tokenizeCode(
  code: string,
  lang: string,
  theme: CodeTheme = "vitesse-light",
): Promise<readonly (readonly CodeToken[])[]> {
  const name = lang.trim().toLowerCase();
  if (!isHighlightable(name)) return [];

  const key = `${theme}\u0000${name}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // 命中即最近使用：删掉再放回，Map 的插入顺序就是 LRU 顺序。
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const shiki = await highlighter();
  const lines = shiki.codeToTokensBase(code, { lang: name, theme });
  const tokens = lines.map((line) =>
    line.map((token) => ({
      text: token.content,
      color: token.color ?? "",
      // fontStyle 是位标志；1 是斜体。
      italic: ((token.fontStyle ?? 0) & 1) === 1,
    })),
  );
  remember(key, tokens);
  return tokens;
}

/** 换了配色或换了文档时清掉。缓存不该跨文档留着旧色。 */
export function forgetHighlights(): void {
  cache.clear();
}
