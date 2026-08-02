/**
 * 排版引擎的向量。
 *
 * 每条钉住的失败：中日两地共用了同一张错表、三档禁则其实是同一档、挤压跑在
 * 断点之后、或者悬挂参与了行宽计算于是断点自己震荡。
 *
 * 这些全部是纯函数，所以不需要浏览器——这正是把引擎做成零依赖零 DOM 的
 * 直接收益：数值可以被断言，而不是被截图。
 */

import { describe, expect, test } from "bun:test";

import {
  candidates,
  classOf,
  hangingAt,
  JA,
  lineEndAdjustment,
  lineStarts,
  measure,
  presetOf,
  widthEm,
  ZH_HANS,
  ZH_HANT,
} from "../src/index.ts";

describe("字符类", () => {
  test("按排版怎么对待它分类，而不是按 Unicode 通用类别", () => {
    // 开与闭必须分开：一个行尾不可留，一个行首不可现。同归「标点」这一类
    // 就问不出这个区别。
    expect(classOf("「")).toBe("open");
    expect(classOf("」")).toBe("close");
    expect(classOf("。")).toBe("stop");
    expect(classOf("・")).toBe("middle");
    expect(classOf("…")).toBe("extender");
  });

  test("假名与汉字同类：它们之间没有 script 边界", () => {
    // 混排间距问的是「这里有没有跨 script 的边界」。把假名单列一类，
    // 「日本語のテキスト」每个假名与汉字之间都会被插进空隙。
    expect(classOf("日")).toBe("ideograph");
    expect(classOf("あ")).toBe("ideograph");
    expect(classOf("ア")).toBe("ideograph");
  });

  test("全角数字跟着表意文字走，半角数字才是西文一侧", () => {
    // 全角数字占一个字身，它与汉字之间没有需要补白的边界。
    expect(classOf("１")).toBe("ideograph");
    expect(classOf("1")).toBe("digit");
  });
});

describe("挤压与混排间距", () => {
  test("连续标点压半个字身，压的是两个内白挨在一起的那几种组合", () => {
    const measured = measure("」「", ZH_HANS);
    expect(measured[1]?.spaceBefore).toBe(-0.5);

    const stopClose = measure("。」", ZH_HANS);
    expect(stopClose[1]?.spaceBefore).toBe(-0.5);
  });

  test("相邻的两个全角标点一律压半字，开闭不分类（CLREQ §6.3.2）", () => {
    // 这条测试原来断言的是相反的结论——`「「` 不压，理由是「两个开括号的内白
    // 都在左侧，中间本来就没有空洞」。那个推理讲得通，但它不是规范。
    //
    // CLREQ §6.3.2 的原文是「两个相邻标点（原占 2 字）压到 1.5 字宽」，没有
    // 按开闭分类。真正做这个区分的是韩文——KLREQ §7.3.3 明写「开+开 / 闭+闭
    // 排紧」，中文规范里没有对应条款。Chromium 实测也压（`「「` 24px vs
    // space-all 下 32px）。
    //
    // 保留这条测试是为了记住它翻过案：推翻规范需要拿真实字体的 ink box 量出
    // 证据，不能靠对字形内白的推理。
    for (const pair of ["「「", "」」", "（（", "，，", "」「", "。」", "」，"]) {
      const measured = measure(pair, ZH_HANS);
      expect(measured[1]?.spaceBefore, `${pair} 未压`).toBe(-0.5);
    }
    // 省略号例外：它占满字身且是一个整体符号，Chromium 实测挤压量也是 0。
    expect(measure("……", ZH_HANS)[1]?.spaceBefore).toBe(0);
  });

  test("混排间距两个方向都加：同一句话的两端不该疏密不同", () => {
    const before = measure("中abc", ZH_HANS);
    const after = measure("abc中", ZH_HANS);
    expect(before[1]?.spaceBefore).toBe(ZH_HANS.interScriptSpacingEm);
    expect(after[3]?.spaceBefore).toBe(ZH_HANS.interScriptSpacingEm);
  });

  test("中日混排间距取各自规范的值，不是同一个数", () => {
    // CSS Text 4 §8.4.1 的规范值是 1/8 ic；JIS 是 1/4 em。常见做法把两者
    // 都写成 1/4（CLREQ §6.3.3 的 1/4 是**上界**而非默认），中文因此偏松。
    expect(ZH_HANS.interScriptSpacingEm).toBe(0.125);
    expect(JA.interScriptSpacingEm).toBe(0.25);

    const zh = measure("中a", ZH_HANS);
    const ja = measure("中a", JA);
    expect(zh[1]?.spaceBefore).not.toBe(ja[1]?.spaceBefore);
  });
});

describe("两地规矩不能共用一张表", () => {
  /**
   * 这一条是整个 preset 设计的理由。
   *
   * GB/T 15834 §5.1.10：行尾全角标点压半个字身。
   * JLREQ §3.1.9：句点是「半角字身 + 后置半角空白」，**行尾这段空白原则上保留**。
   *
   * 两条规矩方向相反，同一张表处理中日必有一边是错的。
   */
  test("行尾标点：简中压半字，日文保留后置空白", () => {
    expect(lineEndAdjustment("stop", ZH_HANS)).toBe(-0.5);
    expect(lineEndAdjustment("stop", JA)).toBe(0);
    expect(lineEndAdjustment("stop", ZH_HANS)).not.toBe(lineEndAdjustment("stop", JA));
  });

  test("悬挂：中文横排默认关，日文句读点可挂", () => {
    // CLREQ §6.1.3 说中文多数出版物不用，繁体横排尤其不宜；JLREQ 把它放在
    // 解说而非规范正文。所以这不是一个全局开关。
    const zhText = measure("第一句。", ZH_HANS);
    const jaText = measure("第一句。", JA);
    expect(hangingAt(zhText, zhText.length - 1, ZH_HANS)).toBeNull();
    expect(hangingAt(zhText, zhText.length - 1, ZH_HANT)).toBeNull();
    expect(hangingAt(jaText, jaText.length - 1, JA)?.amountEm).toBe(0.5);
  });

  test("闭括号不挂：挂出去会让一对括号一半在版心内一半在外", () => {
    const measured = measure("「引用」", JA);
    expect(hangingAt(measured, measured.length - 1, JA)).toBeNull();
  });
});

describe("候选断点与禁则", () => {
  test("行首不可现的类，前面就不是候选断点", () => {
    // 断在 `。` 之前会让它成为下一行的第一个字。
    const measured = measure("第一句。第二句。", ZH_HANS);
    const stopIndex = 3;
    expect(candidates(measured, ZH_HANS).some((entry) => entry.index === stopIndex)).toBe(false);
  });

  test("行尾不可留的类，后面就不是候选断点", () => {
    // `「` 在下标 2；断在下标 3 会让它孤零零留在行尾。
    const measured = measure("他说「你好」", ZH_HANS);
    const afterOpen = 3;
    expect(measured[afterOpen - 1]?.kind).toBe("open");
    expect(candidates(measured, ZH_HANS).some((entry) => entry.index === afterOpen)).toBe(false);
  });

  test("数字与西文内部绝不断开：那是数据读起来的损坏", () => {
    const measured = measure("价格12.5元", ZH_HANS);
    const found = candidates(measured, ZH_HANS).map((entry) => entry.index);
    // `12.5` 占下标 2..5，它内部一处都不能断。
    for (const inside of [3, 4, 5]) expect(found).not.toContain(inside);
  });

  test("三档禁则产生可见不同的断点集合——相同这个选项就是装饰", () => {
    // 含长音、连续标点与西文的日文：三档在这句上必须各不相同。
    const measured = measure("これは……テスト・ケース123です。", JA);
    const loose = candidates(measured, JA, "loose").map((entry) => entry.index);
    const normal = candidates(measured, JA, "normal").map((entry) => entry.index);
    const strict = candidates(measured, JA, "strict").map((entry) => entry.index);

    // 严格档比常规档少：它连数字与西文两侧都不断。
    expect(strict.length).toBeLessThan(normal.length);
    // 宽松档与常规档的断点集合相同，但代价不同——宽松档愿意在长标点处断。
    const loosePenalty = candidates(measured, JA, "loose").find((entry) => entry.penalty === 1);
    const normalPenalty = candidates(measured, JA, "normal").find((entry) => entry.penalty === 1);
    expect(loosePenalty).toBeDefined();
    expect(normalPenalty).toBeUndefined();
    expect(loose.length).toBeGreaterThanOrEqual(normal.length);
  });

  test("同一句话在中日两预设下的断行结果不同", () => {
    // 这一条是 verify:preset-divergence 的单元测试版本：两个预设在同一份
    // 语料上产生相同结果，就说明它们共用了一张表。
    // **语料必须有区分力**：一句话在两个预设下结果相同，往往是语料的问题
    // 而不是实现的问题（附录 A.4 的方法学修正）。第一版语料在 6/7/8/10/12
    // em 下两边逐字相同，量下去才发现差异要到 5.25em 才跨过临界——间距差
    // 每处只有 0.125em，稀疏的边界攒不到一个字身。
    //
    // 所以这里用中西边界**密集**的语料：每两个字就跨一次 script，差值因此
    // 在任何常见行宽下都累积得出来。
    const text = "a中a中a中a中a中a中a中a中。";
    for (const measureEm of [6, 8, 10, 12]) {
      const zh = lineStarts(measure(text, ZH_HANS), ZH_HANS, measureEm);
      const ja = lineStarts(measure(text, JA), JA, measureEm);
      expect(zh).not.toEqual(ja);
    }
  });
});

describe("折行", () => {
  test("放不下就退到上一个候选断点，不在禁则位置硬断", () => {
    const measured = measure("第一句话。第二句话。第三句话。", ZH_HANS);
    const starts = lineStarts(measured, ZH_HANS, 6);
    expect(starts[0]).toBe(0);
    expect(starts.length).toBeGreaterThan(1);
    // 每一行的起点都不能是行首禁则的类。
    for (const start of starts) {
      const character = measured[start];
      if (character === undefined) continue;
      expect(ZH_HANS.forbiddenAtLineStart.has(character.kind)).toBe(false);
    }
  });

  test("行宽量的是调整之后的宽度，不是字符个数", () => {
    // 挤压压掉的半个字身要算进去，否则「放不放得下」这个判断用的是另一份
    // 版面的数字。
    const squeezed = measure("」「", ZH_HANS);
    expect(widthEm(squeezed)).toBe(1.5);
    const plain = measure("你好", ZH_HANS);
    expect(widthEm(plain)).toBe(2);
  });
});

describe("禁则三档", () => {
  // Plan §3.2-4 的判据：三档必须产生**可见不同**的断行，结果相同这个选项
  // 就是装饰。第一版实测下来它确实是装饰的一半——strict 分得开（它在
  // `candidates` 里就删候选），而 loose 与 normal 的候选集完全相同，17 个
  // 下标一模一样，唯一差别是代价 1 对 40，而 `lineStarts` 只读集合成员、
  // 从不读代价。宽松档改的量没有任何东西会读。

  test("宽松档愿意在长标点处断，标准档宁可撑到边界", () => {
    // 语料要让长标点成为**唯一**的低代价选择。夹在中文里不行：表意文字之间
    // 代价是 0、到处都能断，长标点那个位置永远轮不到，于是三档看起来全同。
    // 两侧换成西文（西文内部绝不可断）之后，差异才显出来。
    const text = "alpha・beta・gamma・delta";
    const measured = measure(text, ZH_HANS);

    const loose = lineStarts(measured, ZH_HANS, 8, "loose");
    const normal = lineStarts(measured, ZH_HANS, 8, "normal");

    expect(loose, `宽松与标准给出相同断行 ${JSON.stringify(loose)}，宽松档没有生效`).not.toEqual(
      normal,
    );
    // 宽松档断在中点上；标准档撑过它，断得更靠后。
    expect(loose[1]).toBeLessThan(normal[1] ?? Number.POSITIVE_INFINITY);
  });

  test("严格档连数字与西文之间也不断", () => {
    const text = "总计有1234567890个，还要再加上98765条记录。";
    const measured = measure(text, ZH_HANS);
    const normal = lineStarts(measured, ZH_HANS, 6, "normal");
    const strict = lineStarts(measured, ZH_HANS, 6, "strict");
    expect(strict).not.toEqual(normal);
  });

  test("放不下时高代价断点仍然可用，不会撑破版心", () => {
    // 代价参与选择之后要防的反向缺陷：把高代价断点整个排除，会让本来能断的
    // 地方断不了。这里每一行的起点都必须真的前进，否则就是死循环或长行。
    const text = "wordwordwordword……wordwordwordword";
    const starts = lineStarts(measure(text, ZH_HANS), ZH_HANS, 6, "normal");
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]).toBeGreaterThan(starts[index - 1] ?? -1);
    }
    expect(starts.length).toBeGreaterThan(1);
  });
});

describe("预设查表", () => {
  test("三种内建预设各自可取", () => {
    expect(presetOf("zh-hans").id).toBe("zh-hans");
    expect(presetOf("zh-hant").id).toBe("zh-hant");
    expect(presetOf("ja").id).toBe("ja");
  });

  test("未知语言落到简中，而不是抛错或落到日文", () => {
    expect(presetOf("ko").id).toBe("zh-hans");
  });
});

describe("量长文的成本", () => {
  test("带几千个不可分区间的 40 万字符：measure 不许退回逐字重扫区间表", () => {
    // 曾经每个字符都从头扫一遍区间表，字符数 × 区间数比较下来，一块 400KB
    // 的导入材料（三千多个数值/URL 区间）实测 5,286ms；游标修复后同机
    // ~300ms。2,500ms 的界留给慢机器十倍余量，又足以抓住任何逐字重扫的
    // 回退。语料必须真的带几千个区间，否则量不到那条复杂度。
    const unit = "数值 3.14 与 273.15°C 交替出现，混着 English words 与中文。";
    let text = "";
    while (text.length < 400_000) text += unit;
    const started = performance.now();
    const measured = measure(text, ZH_HANS);
    const elapsed = performance.now() - started;
    expect(measured.length).toBe([...text].length);
    expect(elapsed).toBeLessThan(2_500);
  });
});
