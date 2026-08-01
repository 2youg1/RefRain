import { describe, expect, test } from "bun:test";
import { applyPunctuationFinding, convertPunctuation, findPunctuation } from "../src/punctuation";

describe("punctuation suggestions", () => {
  test("suggests one Chinese punctuation replacement without changing the source", () => {
    const source = "你好,世界. 下一句?";
    const findings = findPunctuation("b1", source);
    expect(findings.map(({ original, suggested }) => [original, suggested])).toEqual([
      [",", "，"],
      [".", "。"],
      ["?", "？"],
    ]);
    expect(source).toBe("你好,世界. 下一句?");
    const first = findings[0];
    if (first === undefined) throw new Error("expected one finding");
    expect(applyPunctuationFinding(source, first)).toBe("你好，世界. 下一句?");
  });

  test("suggests full-width punctuation in English prose", () => {
    const findings = findPunctuation("b2", "Hello，world！");
    expect(findings.map(({ original, suggested }) => [original, suggested])).toEqual([
      ["，", ","],
      ["！", "!"],
    ]);
  });

  test("does not touch URLs, decimals, abbreviations, inline code, or fenced code", () => {
    expect(findPunctuation("url", "见 https://example.com/a,b?x=1.2")).toEqual([]);
    expect(findPunctuation("decimal", "版本 v1.2.3 与 3.14 不变")).toEqual([]);
    expect(findPunctuation("abbr", "Use e.g. this form, not i.e. that one.")).toEqual([]);
    expect(findPunctuation("inline", "运行 `foo(a,b);` 即可")).toEqual([]);
    expect(findPunctuation("fence", "```ts\nfoo(a,b);\n```")).toEqual([]);
  });

  test("leaves a run of dots alone instead of converting them one by one", () => {
    // Measured before the fix: `他想了想...然后说。` came back as
    // `他想了想。.。然后说。` — the first and third dots each saw a CJK
    // neighbour and became 。, the middle one saw none and stayed. Three
    // characters the author typed as one gesture came out as three different
    // characters, which is data loss, not a suggestion.
    expect(findPunctuation("ellipsis", "他想了想...然后说。")).toEqual([]);
    expect(findPunctuation("two-dots", "等等..好吧。")).toEqual([]);

    // Still conservative in the other direction: a lone period between CJK is
    // exactly what this feature is for, and the run rule must not swallow it.
    const [single] = findPunctuation("single", "这样.很好");
    expect(single?.original).toBe(".");
    expect(single?.suggested).toBe("。");
  });

  test("refuses a stale finding instead of replacing another occurrence", () => {
    const [finding] = findPunctuation("b3", "甲,乙");
    if (finding === undefined) throw new Error("expected one finding");
    expect(() => applyPunctuationFinding("甲；乙", finding)).toThrow("source changed");
  });
});

describe("一键切换", () => {
  test("一次转完整块，且与逐条套用结果完全相同", () => {
    // 一键切换与右键菜单必须给出同一个答案。它们若各写一套匹配规则，就是
    // 同一事实的两个权威——漂开时没有任何东西会报错，表现是右键说该转的
    // 地方一键不转。这条断言把两条路径钉在一起。
    const source = "你好,世界. 下一句?";
    const oneShot = convertPunctuation("b1", source);

    let stepwise = source;
    for (const finding of [...findPunctuation("b1", source)].reverse()) {
      stepwise = applyPunctuationFinding(stepwise, finding);
    }

    expect(oneShot).toBe("你好，世界。 下一句？");
    expect(oneShot).toBe(stepwise);
    // 源串不被改动。
    expect(source).toBe("你好,世界. 下一句?");
  });

  test("没有一处该转时返回 null，而不是返回一份相同的文本", () => {
    // 返回相同文本会让调用方提交一个「替换成完全一样的内容」的改动，账本
    // 于是记下一笔什么也没发生的事，作者回头看历史无从分辨它和真改动。
    expect(convertPunctuation("b1", "纯中文，没有半角标点。")).toBeNull();
    expect(convertPunctuation("b1", "")).toBeNull();
  });

  test("例外一条都不能破：代码、小数、缩写、连续点、URL", () => {
    // Plan 3.2-1：**要设计的是例外**。`arr[0]` → `arr［0］` 是数据损坏而不是
    // 排版；`3.14` 变 `3。14` 同理。每条例外单独一个用例，一条坏掉就指得出
    // 是哪一条——合成一个大字符串断言的话，报错只会说「整段不相等」。
    //
    // 验红：把 convertPunctuation 改成朴素的全表替换，五条全部变红。
    expect(convertPunctuation("b1", "调用 `arr[0]` 取值。")).toBeNull();
    // 小数点不转，而同一句里那个真该转的逗号照转——这条比「整句不转」更强：
    // 它证明规则是**逐字符**判的，不是遇到数字就整块放弃。
    //
    // 逗号紧贴中文才转。第一版这里写的是 `3.14, 记住了`（逗号后有空格），
    // 引擎正确地判定它两侧都不是 CJK 而拒绝转换，于是返回 null——我当时把
    // 引擎的正确行为读成了缺陷。**断言写错时先去问引擎实际怎么判的**，
    // 而不是改引擎来迁就断言。
    expect(convertPunctuation("b1", "圆周率是3.14,记住了")).toBe("圆周率是3.14，记住了");
    expect(convertPunctuation("b1", "如 e.g. 这样的缩写")).toBeNull();
    expect(convertPunctuation("b1", "他想了想...然后说")).toBeNull();
    expect(convertPunctuation("b1", "见 https://example.com/a,b 一文")).toBeNull();
  });

  test("围栏块整块不碰", () => {
    expect(convertPunctuation("b1", "```\nlet a = [1,2];\n```")).toBeNull();
  });
});
