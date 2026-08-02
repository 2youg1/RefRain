/**
 * 语法高亮：文档 §7 门禁清单里能在单元层问清楚的那几条。
 *
 * 零出网、无 WASM、无 dynamic chunk 是**产物**层面的事实，归 `verify:no-network`；
 * 这里问的是模块自身的行为。
 */

import { describe, expect, test } from "bun:test";

import {
  codeThemeFor,
  forgetHighlights,
  isHighlightable,
  tokenizeCode,
} from "../src/code-highlight";

describe("语言集显式有限", () => {
  test("注册过的认得，含别名", () => {
    expect(isHighlightable("rust")).toBe(true);
    expect(isHighlightable("typescript")).toBe(true);
    expect(isHighlightable("ts")).toBe(true);
    expect(isHighlightable("  Rust  ")).toBe(true);
  });

  test("没注册的语言降级为纯文本，而不是报错或去加载", async () => {
    expect(isHighlightable("cobol")).toBe(false);
    // 返回空数组＝调用方按纯文本渲染。不抛异常，不发起任何加载。
    await expect(tokenizeCode("IDENTIFICATION DIVISION.", "cobol")).resolves.toEqual([]);
    await expect(tokenizeCode("x", "")).resolves.toEqual([]);
  });
});

describe("着色本身", () => {
  test("CJK 完整保留：注释、标识符、字符串都不被切坏", async () => {
    const source = 'fn main() {\n    let 说明 = "全角「引号」也要对";\n}';
    const lines = await tokenizeCode(source, "rust");
    const text = lines.map((line) => line.map((token) => token.text).join("")).join("\n");
    expect(text).toBe(source);
    expect(text).toContain("说明");
    expect(text).toContain("「引号」");
  });

  test("同一段代码的字符逐字往返无损", async () => {
    // 模板插值本身是要测的语法，用转义写出来以免被读成误写的模板字面量。
    const source = "const 名前 = `模板 \u0024{x} 字符串`;";
    const lines = await tokenizeCode(source, "typescript");
    expect(
      lines
        .flat()
        .map((token) => token.text)
        .join(""),
    ).toBe(source);
  });

  test("token 带得回颜色，注释与关键字不同色", async () => {
    const lines = await tokenizeCode("// 注释\nlet x = 1;", "rust");
    const colors = new Set(lines.flat().map((token) => token.color));
    // 至少要分出注释、关键字、数字几档，否则等于没上色。
    expect(colors.size).toBeGreaterThan(2);
  });

  test("行数与源码一致——高亮不改变行数，估高才不必为它调整", async () => {
    const source = "a\nb\nc\nd";
    expect((await tokenizeCode(source, "bash")).length).toBe(4);
  });
});

describe("默认代码配色按界面主题挑", () => {
  test("夜间两套配夜间代码色，切换时不跳色", () => {
    expect(codeThemeFor("sumi")).toBe("vitesse-dark");
    expect(codeThemeFor("shao")).toBe("vitesse-dark");
  });

  test("日间五套配日间代码色", () => {
    for (const theme of ["tou", "kasumi", "suna", "hua", "wabi"]) {
      expect(codeThemeFor(theme)).toBe("vitesse-light");
    }
  });

  test("没见过的主题名不至于崩，落到日间", () => {
    expect(codeThemeFor("")).toBe("vitesse-light");
  });
});

describe("缓存", () => {
  test("同一段代码问两次给同一个结果对象，说明没重算", async () => {
    forgetHighlights();
    const first = await tokenizeCode("let x = 1;", "rust");
    const second = await tokenizeCode("let x = 1;", "rust");
    expect(second).toBe(first);
  });

  test("换了配色就不能命中旧色的缓存", async () => {
    forgetHighlights();
    const light = await tokenizeCode("let x = 1;", "rust", "vitesse-light");
    const dark = await tokenizeCode("let x = 1;", "rust", "vitesse-dark");
    expect(dark).not.toBe(light);
    // 同一段代码在两套配色下颜色必须真的不同，否则缓存键形同虚设。
    expect(dark.flat()[0]?.color).not.toBe(light.flat()[0]?.color);
  });

  test("清掉之后重算，不留旧文档的颜色", async () => {
    const before = await tokenizeCode("let x = 1;", "rust");
    forgetHighlights();
    const after = await tokenizeCode("let x = 1;", "rust");
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });
});

/**
 * 惰性注册特有的失效方式。
 *
 * 起步不注册任何语言（省 106ms 的正则编译）之后，多了三种此前不可能发生的
 * 坏法：语言没被注册就去着色、别名查不到那份语法、同一种语言并发编译两遍。
 * 前两种会静默返回空数组——手稿里的代码块变成没有颜色的等宽字，而没有任何
 * 报错。
 */
describe("惰性注册", () => {
  test("新加的语言真的能着色，不是只被 isHighlightable 认得", async () => {
    // 认得与着得出是两件事：KNOWN 从语法定义派生，注册却是另一条路径，
    // 只查前者会让一个从未注册成功的语言看起来是好的。
    for (const lang of ["go", "yaml", "docker", "sql", "latex"]) {
      expect(isHighlightable(lang)).toBe(true);
      const tokens = await tokenizeCode("x", lang);
      expect(tokens.length, `${lang} 注册后应产出 token`).toBeGreaterThan(0);
    }
  });

  test("按别名请求也能着色，不只是按真名", async () => {
    // 这批别名是作者会写在围栏上的写法。查表若只用真名建，
    // ```bash 就会静默变成纯文本。
    for (const [alias, real] of [
      ["bash", "shellscript"],
      ["makefile", "make"],
      ["dockerfile", "docker"],
      ["lean4", "lean"],
    ] as const) {
      const byAlias = await tokenizeCode("x", alias);
      const byReal = await tokenizeCode("x", real);
      expect(byAlias.length, `别名 ${alias} 应着色`).toBeGreaterThan(0);
      expect(byAlias).toEqual(byReal);
    }
  });

  test("同一种语言并发请求只编译一遍", async () => {
    // 一屏里多个同语言围栏会同时到达。若用布尔记「已注册」，第二个调用
    // 会在第一个 await 完成之前读到 false，把省下的编译又花回去。
    //
    // 第一版断言八个结果彼此相等——那与要防的性质无关：重复编译得到的
    // 结果同样相等，它只是白花时间。实测把去重改成布尔之后，那一版照绿。
    // 要量的是 loadLanguage 被调用了几次，所以这里数它。
    const { createHighlighterCore } = await import("shiki/core");
    const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
    const { default: light } = await import("@shikijs/themes/vitesse-light");

    const core = await createHighlighterCore({
      langs: [],
      themes: [light],
      engine: createJavaScriptRegexEngine(),
    });

    let compiles = 0;
    const realLoad = core.loadLanguage.bind(core);
    const counting = Object.assign(Object.create(Object.getPrototypeOf(core)), core, {
      loadLanguage: (...args: Parameters<typeof realLoad>) => {
        compiles += 1;
        return realLoad(...args);
      },
    }) as typeof core;

    // 自己的注册表：模块那张是跨测试累积的，用它计数会得到 0（go 早被
    // 前面的用例注册过），而 0 与「只编译一遍」在断言里长得不一样但同样
    // 没有量到并发去重。
    const { registerInto } = await import("../src/code-highlight");
    const table = new Map<string, Promise<void>>();

    await Promise.all(Array.from({ length: 8 }, () => registerInto(counting, "go", table)));

    expect(compiles, "八个并发请求只该编译一遍").toBe(1);
  });

  test("起步不注册任何语言——第一次着色之前不编译 34 份语法", async () => {
    // 这条守的是这次改动的全部收益，而找到一个能真正区分惰性与全量的
    // 断言花了三版：
    //
    // 第一版按源码断言 `toContain("langs: []")`，被同一个文件注释里的
    // `| 起步 \`langs: []\` | 0.4 ms |` 满足了——命中的是说明文字不是代码。
    //
    // 第二版数模块单例注册了几种，实测 24。因为一种语法会拖进它嵌入的
    // 其他语法（ruby 拖十二种），24 与全量的 34 太近，区分不开。
    //
    // 真正区分两者的是**起步那一刻**：起步耗时。全量注册要为 34 份语法
    // 编译正则（本机实测 106.6 ms），空表只要 0.4 ms，差两个数量级。用同
    // 一份 LANGS 各造一个高亮器来对拍——不看绝对毫秒（机器快慢不同），
    // 只要求两者差一个数量级以上。
    const { createHighlighterCore } = await import("shiki/core");
    const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
    const { default: light } = await import("@shikijs/themes/vitesse-light");
    const { EMBEDDED_LANGUAGES } = await import("../src/code-highlight");

    const build = async (langs: unknown[]) => {
      const started = performance.now();
      const core = await createHighlighterCore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        langs: langs as never,
        themes: [light],
        engine: createJavaScriptRegexEngine(),
      });
      return { ms: performance.now() - started, core };
    };

    const empty = await build([]);
    const full = await build([...EMBEDDED_LANGUAGES]);

    expect(empty.core.getLoadedLanguages()).toHaveLength(0);
    expect(full.core.getLoadedLanguages().length, "全量注册应当认得全部内嵌语法").toBeGreaterThan(
      30,
    );
    expect(
      full.ms,
      `起步应比空表贵一个数量级以上（空 ${empty.ms.toFixed(1)}ms，满 ${full.ms.toFixed(1)}ms）`,
    ).toBeGreaterThan(empty.ms * 10);

    // 以上两个高亮器都是这个测试自己造的，它们只证明了一件关于 Shiki 的
    // 事实：全量起步比空表贵十倍。**它们不证明本模块走的是空表那条路。**
    // 把 `langs: []` 改回 `langs: LANGS` 时上面全部照绿——守卫挂在了没人
    // 收到的那一档。
    //
    // 唯一能区分的是模块自己那个高亮器：在只问过一种语言之后，它认得的
    // 语法必须显著少于全量。用一个刚问过的新语言来定位——若起步是全量，
    // 那么第一次着色之前它就已经认得全部 34 种了。
    const { loadedLanguageCount } = await import("../src/code-highlight");
    const registeredNow = await loadedLanguageCount();
    const embedded = full.core.getLoadedLanguages().length;
    expect(
      registeredNow,
      `模块的高亮器认得 ${registeredNow} 种，全量是 ${embedded} 种——` +
        "两者相当，说明起步就注册了全部，惰性注册没有生效",
    ).toBeLessThan(embedded - 5);
  });
});
