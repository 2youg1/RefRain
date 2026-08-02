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

import c from "@shikijs/langs/c";
import cmake from "@shikijs/langs/cmake";
import codeowners from "@shikijs/langs/codeowners";
import css from "@shikijs/langs/css";
import csv from "@shikijs/langs/csv";
import diff from "@shikijs/langs/diff";
import docker from "@shikijs/langs/docker";
import dotenv from "@shikijs/langs/dotenv";
import gitCommit from "@shikijs/langs/git-commit";
import go from "@shikijs/langs/go";
import hcl from "@shikijs/langs/hcl";
import ini from "@shikijs/langs/ini";
import json from "@shikijs/langs/json";
import json5 from "@shikijs/langs/json5";
import jsonc from "@shikijs/langs/jsonc";
import kdl from "@shikijs/langs/kdl";
import latex from "@shikijs/langs/latex";
import lean from "@shikijs/langs/lean";
import log from "@shikijs/langs/log";
import lua from "@shikijs/langs/lua";
import make from "@shikijs/langs/make";
import markdown from "@shikijs/langs/markdown";
import proto from "@shikijs/langs/proto";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import sshConfig from "@shikijs/langs/ssh-config";
import toml from "@shikijs/langs/toml";
import tsv from "@shikijs/langs/tsv";
import typescript from "@shikijs/langs/typescript";
import wikitext from "@shikijs/langs/wikitext";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import vitesseDark from "@shikijs/themes/vitesse-dark";
import vitesseLight from "@shikijs/themes/vitesse-light";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import type { DocumentFormat } from "./model";

/**
 * 手稿里出现得起的语言。
 *
 * **导入的是真名，不是别名。** `@shikijs/langs` 里有一批文件只是转发：
 * `bash` → `shellscript`、`makefile` → `make`、`dockerfile` → `docker`、
 * `lean4` → `lean`。按别名导入会引入同一份语法两次的风险，而按别名估体积
 * 会得出荒谬的数字——`makefile.mjs` 只有 67 字节（gzip 后 94），真正的
 * `make.mjs` 是 9,993 字节（gzip 1,785）。别名仍然认得，因为下面的 KNOWN
 * 是从每份语法自己声明的 `aliases` 派生的。
 *
 * **体积必须量打包产物，不能量语法文件。** 两者差一个数量级，因为一种语法
 * 会静态 import 它嵌入的其他语法。本轮实测（`bun run build:web` 后的
 * index-*.js，未压缩 / gzip）：
 *
 * | 清单 | 未压缩 | gzip |
 * |---|---:|---:|
 * | 8 种（v0.2.2） | 827 KB | 174 KB |
 * | +6 编程语言 | 2,328 KB | 318 KB |
 * | +4 标记 | 2,473 KB | 334 KB |
 * | +17 配置 | 2,536 KB | 346 KB |
 *
 * 逐种量下来，那 1,501 KB 里有 1,449 KB 是 **ruby 一种**带来的：它静态
 * import 了 c、cpp、css、graphql、haml、html、javascript、lua、shellscript、
 * sql、xml、yaml 共十二种。其余五种（c/go/lean/lua/sql）合计只有 236 KB。
 *
 * 所以 **ruby 不收**，理由与不收 cpp 完全一样，而且实测代价更大——它还会
 * 把已经被舍弃的 cpp 从后门拖回来，让那个决定失效。
 * **舍弃 `cpp`**：一种 429 KB，而 `c` 已经能把 C++ 的结构高亮对，关键字
 * 覆盖不全，省这一份值这个折扣。
 *
 * 收下的 34 种，实测产物：未压缩 1,212 KB，gzip 228 KB。较 8 种基线
 * 增加 404 KB / 59 KB —— 也就是说，多出来的 26 种语法在 gzip 后只花了
 * 59 KB，而单独一个 ruby 要花 136 KB。
 */
const LANGS = [
  // 手稿里最常出现的几种，v0.2.2 就内嵌了。
  shellscript,
  css,
  json,
  markdown,
  python,
  rust,
  toml,
  typescript,
  // 正经编程语言。
  c,
  go,
  lean,
  lua,
  sql,
  // 标记与排版。
  latex,
  wikitext,
  xml,
  yaml,
  // 配置与运维格式。整组 gzip 只有 17,894，是这批里性价比最高的一段：
  // 一份技术手稿里出现 Dockerfile 或 YAML 的概率远高于出现 Lua。
  cmake,
  codeowners,
  csv,
  diff,
  docker,
  dotenv,
  gitCommit,
  hcl,
  ini,
  json5,
  jsonc,
  kdl,
  log,
  make,
  proto,
  sshConfig,
  tsv,
];

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
 * 高亮器只造一次，而且**起步不带任何语言**。
 *
 * 造它要为每种语言编译一批正则，实测（本机，34 种，JavaScript 引擎）：
 *
 * | 做法 | 耗时 |
 * |---|---:|
 * | 起步注册全部 34 种 | 106.6 ms |
 * | 起步 `langs: []` | 0.4 ms |
 * | 之后每追加一种 | 0.3–0.7 ms |
 *
 * 一份只有 Rust 围栏的手稿因此省掉约 99% 的编译。省的是 CPU 不是体积：
 * 语法数据仍然全部静态打进产物（那是「零出网」要求的，见文件头），这里
 * 改的只是**什么时候把它们编译成正则**。
 */
function highlighter(): Promise<HighlighterCore> {
  engine ??= createHighlighterCore({
    langs: [],
    themes: THEMES,
    engine: createJavaScriptRegexEngine(),
  });
  return engine;
}

/**
 * 已经注册进高亮器的语言。
 *
 * 存的是 Promise 而不是布尔：同一屏里多个围栏会同时问同一种语言，而
 * `loadLanguage` 是异步的——存布尔的话，第二个调用会在第一个完成之前
 * 看到 false，于是同一份语法编译两遍，把这次改动省下的时间又花回去。
 */
const registered = new Map<string, Promise<void>>();

/** 语言名（含别名）到那份语法定义。别名与真名都能查到同一份。 */
const BY_NAME = new Map(
  LANGS.flatMap((lang) => {
    const entries = Array.isArray(lang) ? lang : [lang];
    return entries.flatMap((entry) =>
      [entry.name, ...(entry.aliases ?? [])].map((name) => [name, lang] as const),
    );
  }),
);

/**
 * 确保这一种语言已经注册。已注册或正在注册时不重复编译。
 *
 * 注册表是参数而不是直接读模块那个：并发去重只有数 `loadLanguage` 的调用
 * 次数才量得到，而共享一张跨测试累积的表会让计数取决于测试的执行顺序。
 * 产品只有一张表，由下面的 `ensureRegistered` 传进来。
 */
export function registerInto(
  shiki: HighlighterCore,
  name: string,
  into: Map<string, Promise<void>>,
): Promise<void> {
  const existing = into.get(name);
  if (existing !== undefined) return existing;

  const grammar = BY_NAME.get(name);
  if (grammar === undefined) return Promise.resolve();

  const loading = shiki.loadLanguage(grammar).then(() => undefined);
  into.set(name, loading);
  return loading;
}

function ensureRegistered(shiki: HighlighterCore, name: string): Promise<void> {
  return registerInto(shiki, name, registered);
}

export function isHighlightable(lang: string): boolean {
  return KNOWN.has(lang.trim().toLowerCase());
}

/**
 * The grammar a whole plain-text document highlights with, keyed by its
 * format. `markdown` has none: its fences declare their own languages and
 * the prose between them takes no grammar.
 *
 * `html` maps to `xml` on purpose. Shiki's real `html` grammar statically
 * imports JavaScript and CSS — measured 62 KB for `html.mjs` plus 185 KB for
 * `javascript.mjs`, against 6 KB for the XML grammar already embedded. HTML
 * is edited as source here and never rendered, so tags, attributes and
 * comments are all the highlighting must tell apart, and those the XML
 * grammar already colours.
 *
 * The Record is exhaustive on purpose: a format added to the bridge's
 * `DocumentFormat` without a decision here fails the type check.
 */
const DOCUMENT_LANGUAGE: Readonly<Record<DocumentFormat, string | null>> = {
  markdown: null,
  latex: "latex",
  typescript: "typescript",
  rust: "rust",
  python: "python",
  go: "go",
  lean: "lean",
  css: "css",
  html: "xml",
  xml: "xml",
  toml: "toml",
  yaml: "yaml",
};

/**
 * The grammar for a whole document of this format, or null when the format
 * takes no grammar. Every name the table holds is embedded in this build —
 * that is what the table was measured against.
 */
export function documentLanguage(format: DocumentFormat): string | null {
  return DOCUMENT_LANGUAGE[format];
}

/**
 * 围栏声明的语言；声明为空或本构建没内嵌它时返回 null。
 *
 * 信息串是开栏反引号之后的整行，其中只有第一个词是语言，其余是别的工具用的
 * 元数据（`rust ignore no_run`）。不认得的语言退化成纯文本——语法定义全部在
 * 构建期内嵌，运行期不会为了一个陌生语言去取任何东西。
 */
export function fenceLanguage(text: string): string | null {
  const declared = declaredFenceLanguage(text);
  return declared !== null && isHighlightable(declared) ? declared : null;
}

/**
 * 围栏第一行声明的语言，不管有没有人认得它。
 *
 * 与 `fenceLanguage` 的区别是那一层 `isHighlightable` 过滤：高亮器只认它注册
 * 过的语言，而图表围栏（`mermaid`/`nomnoml`）本来就不该由高亮器处理。把图表
 * 判据挂在 `fenceLanguage` 下游会让它永远读到 null——实测就是这样，门禁报
 * 「零张图」而所有单测全绿。
 */
export function declaredFenceLanguage(text: string): string | null {
  const breakAt = text.indexOf("\n");
  const firstLine = breakAt === -1 ? text : text.slice(0, breakAt);
  const info = firstLine.replace(/^[`~]+/, "").trim();
  const language = info.split(/\s+/)[0] ?? "";
  return language === "" ? null : language;
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
  await ensureRegistered(shiki, name);
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

/**
 * 此刻已经注册进高亮器的语言种数。
 *
 * 只给测试用，而它守的是这次改动的全部收益：起步 `langs: []` 若被改回
 * `LANGS`，这个数会从「问过几种就是几种」变成 34。行为量得到，源码字符串
 * 量不到——按源码断言会被同一个文件里的注释满足。
 */
export async function loadedLanguageCount(): Promise<number> {
  // 问高亮器自己，不问 `registered`：后者只记这个模块主动注册过的，
  // 起步若改回 `langs: LANGS`，它照样是 0，于是探针对那次回归视而不见。
  // 唯一的权威是高亮器此刻真正编译了几份语法。
  return (await highlighter()).getLoadedLanguages().length;
}

/**
 * 内嵌的全部语法定义。
 *
 * 导出只为让测试能拿同一份清单去量「全量注册要多久」——起步耗时是惰性
 * 注册与全量注册唯一差得开的量（本机 0.4ms 对 106.6ms）。产品代码不该用
 * 它：用了就等于绕开惰性注册。
 */
export const EMBEDDED_LANGUAGES = LANGS;

/** 换了配色或换了文档时清掉。缓存不该跨文档留着旧色。 */
export function forgetHighlights(): void {
  cache.clear();
}
